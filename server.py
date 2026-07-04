#!/usr/bin/env python3
import json
import mimetypes
import os
import socket
import ssl
import subprocess
import secrets
import threading
import time
import urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler


ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, "certs")
CERT_FILE = os.path.join(CERT_DIR, "partylink.crt")
KEY_FILE = os.path.join(CERT_DIR, "partylink.key")
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/app.js": "app.js",
}

rooms = {}
condition = threading.Condition()
next_seq = 1


def public_peer(peer):
    return {
        "id": peer["id"],
        "name": peer["name"],
        "muted": peer.get("muted", False),
        "deafened": peer.get("deafened", False),
        "joinedAt": peer["joinedAt"],
    }


def make_code():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(5))


def push_message(room_code, target_id, body):
    global next_seq
    room = rooms.get(room_code)
    if not room:
        return
    target = room["peers"].get(target_id)
    if not target:
        return
    item = dict(body)
    item["seq"] = next_seq
    item["sentAt"] = time.time()
    next_seq += 1
    target["messages"].append(item)


def broadcast(room_code, body, exclude=None):
    room = rooms.get(room_code)
    if not room:
        return
    for peer_id in list(room["peers"].keys()):
        if peer_id != exclude:
            push_message(room_code, peer_id, body)


def cleanup_room(room_code):
    room = rooms.get(room_code)
    if room and not room["peers"]:
        rooms.pop(room_code, None)


def local_ipv4_addresses():
    addresses = {"127.0.0.1"}
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            addresses.add(info[4][0])
    except OSError:
        pass

    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        addresses.add(sock.getsockname()[0])
    except OSError:
        pass
    finally:
        if sock:
            sock.close()

    return sorted(address for address in addresses if not address.startswith("169.254."))


def ensure_https_certificate(hosts):
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        return True

    os.makedirs(CERT_DIR, exist_ok=True)
    config_path = os.path.join(CERT_DIR, "openssl.cnf")
    dns_names = ["localhost"]
    ip_names = []
    for host in hosts:
        parts = host.split(".")
        if len(parts) == 4 and all(part.isdigit() for part in parts):
            ip_names.append(host)
        else:
            dns_names.append(host)

    alt_lines = []
    for index, name in enumerate(dict.fromkeys(dns_names), start=1):
        alt_lines.append(f"DNS.{index} = {name}")
    for index, address in enumerate(dict.fromkeys(ip_names), start=1):
        alt_lines.append(f"IP.{index} = {address}")

    with open(config_path, "w", encoding="utf-8") as f:
        f.write(
            "\n".join(
                [
                    "[req]",
                    "distinguished_name = req_distinguished_name",
                    "x509_extensions = v3_req",
                    "prompt = no",
                    "",
                    "[req_distinguished_name]",
                    "CN = PartyLink Local",
                    "",
                    "[v3_req]",
                    "subjectAltName = @alt_names",
                    "",
                    "[alt_names]",
                    *alt_lines,
                    "",
                ]
            )
        )

    try:
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-nodes",
                "-newkey",
                "rsa:2048",
                "-days",
                "365",
                "-keyout",
                KEY_FILE,
                "-out",
                CERT_FILE,
                "-config",
                config_path,
                "-extensions",
                "v3_req",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def make_server(port, use_https, hosts):
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    if use_https:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    return server


def print_urls(port, use_https, hosts):
    scheme = "https" if use_https else "http"
    local_url = f"{scheme}://127.0.0.1:{port}"
    lan_urls = [f"{scheme}://{host}:{port}" for host in hosts if not host.startswith("127.")]
    print(f"PartyLink running at {local_url}", flush=True)
    if use_https:
        print("First browser visit may show a certificate warning. Choose to continue, then allow microphone access.", flush=True)
    else:
        print("HTTP mode is fine for localhost, but friends' browsers may block microphone access.", flush=True)
    if lan_urls:
        print("Share one of these LAN addresses with friends on the same Wi-Fi/network:", flush=True)
        for url in lan_urls:
            print(f"  {url}", flush=True)
    else:
        print("No LAN address was detected. Check Wi-Fi/network settings if friends cannot open it.", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "PartyLink/1.0"

    def log_message(self, fmt, *args):
        return

    def send_json(self, status, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def request_origin(self):
        configured = os.environ.get("PARTYLINK_PUBLIC_URL", "").strip().rstrip("/")
        if configured:
            return configured

        forwarded_proto = self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip()
        forwarded_host = self.headers.get("X-Forwarded-Host", "").split(",")[0].strip()
        proto = forwarded_proto or ("https" if getattr(self.server, "use_https", False) else "http")
        host = forwarded_host or self.headers.get("Host", "").strip()
        if host:
            return f"{proto}://{host}"

        port = self.server.server_address[1]
        return f"{proto}://127.0.0.1:{port}"

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/poll":
            self.handle_poll(parsed)
            return
        if parsed.path == "/api/info":
            self.handle_info()
            return

        filename = STATIC_FILES.get(parsed.path)
        if not filename:
            self.send_error(404)
            return

        path = os.path.join(ROOT, filename)
        if not os.path.isfile(path):
            self.send_error(404)
            return

        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/join":
                self.handle_join()
            elif parsed.path == "/api/send":
                self.handle_send()
            elif parsed.path == "/api/state":
                self.handle_state()
            elif parsed.path == "/api/leave":
                self.handle_leave()
            else:
                self.send_error(404)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Invalid JSON"})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})

    def handle_join(self):
        data = self.read_json()
        name = str(data.get("name", "")).strip()[:24] or "Player"
        requested = str(data.get("room", "")).strip().upper()
        with condition:
            room_code = requested if requested else make_code()
            while not requested and room_code in rooms:
                room_code = make_code()

            room = rooms.setdefault(room_code, {"peers": {}, "createdAt": time.time()})
            client_id = secrets.token_hex(8)
            peers = [public_peer(peer) for peer in room["peers"].values()]
            peer = {
                "id": client_id,
                "name": name,
                "muted": False,
                "deafened": False,
                "joinedAt": time.time(),
                "messages": [],
            }
            room["peers"][client_id] = peer
            broadcast(room_code, {"type": "peer-joined", "peer": public_peer(peer)}, exclude=client_id)
            condition.notify_all()

        self.send_json(200, {"room": room_code, "clientId": client_id, "peers": peers})

    def handle_send(self):
        data = self.read_json()
        room_code = str(data.get("room", "")).strip().upper()
        sender = str(data.get("from", ""))
        target = data.get("to")
        message_type = str(data.get("type", ""))
        payload = data.get("payload", {})

        with condition:
            room = rooms.get(room_code)
            if not room or sender not in room["peers"]:
                self.send_json(404, {"error": "Room or sender not found"})
                return

            body = {"type": message_type, "from": sender, "payload": payload}
            if target:
                push_message(room_code, str(target), body)
            else:
                broadcast(room_code, body, exclude=sender)
            condition.notify_all()

        self.send_json(200, {"ok": True})

    def handle_state(self):
        data = self.read_json()
        room_code = str(data.get("room", "")).strip().upper()
        client_id = str(data.get("clientId", ""))
        with condition:
            room = rooms.get(room_code)
            if not room or client_id not in room["peers"]:
                self.send_json(404, {"error": "Room or peer not found"})
                return
            peer = room["peers"][client_id]
            peer["muted"] = bool(data.get("muted", False))
            peer["deafened"] = bool(data.get("deafened", False))
            broadcast(room_code, {"type": "peer-state", "peer": public_peer(peer)}, exclude=client_id)
            condition.notify_all()
        self.send_json(200, {"ok": True})

    def handle_leave(self):
        data = self.read_json()
        room_code = str(data.get("room", "")).strip().upper()
        client_id = str(data.get("clientId", ""))
        with condition:
            room = rooms.get(room_code)
            if room and client_id in room["peers"]:
                room["peers"].pop(client_id, None)
                broadcast(room_code, {"type": "peer-left", "from": client_id}, exclude=client_id)
                cleanup_room(room_code)
                condition.notify_all()
        self.send_json(200, {"ok": True})

    def handle_info(self):
        port = self.server.server_address[1]
        scheme = "https" if getattr(self.server, "use_https", False) else "http"
        hosts = getattr(self.server, "hosts", ["127.0.0.1"])
        origin = self.request_origin()
        self.send_json(
            200,
            {
                "secure": origin.startswith("https://"),
                "publicUrl": origin,
                "localUrl": f"{scheme}://127.0.0.1:{port}",
                "lanUrls": [f"{scheme}://{host}:{port}" for host in hosts if not host.startswith("127.")],
            },
        )

    def handle_poll(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        room_code = query.get("room", [""])[0].strip().upper()
        client_id = query.get("clientId", [""])[0]
        after = int(query.get("after", ["0"])[0] or "0")
        deadline = time.time() + 25

        with condition:
            while True:
                room = rooms.get(room_code)
                peer = room["peers"].get(client_id) if room else None
                if not peer:
                    self.send_json(404, {"error": "Room or peer not found"})
                    return

                messages = [msg for msg in peer["messages"] if msg["seq"] > after]
                if messages or time.time() >= deadline:
                    break
                condition.wait(timeout=max(0.1, deadline - time.time()))

        self.send_json(200, {"messages": messages})


def main():
    port = int(os.environ.get("PORT", "8765"))
    hosts = local_ipv4_addresses()
    use_https = os.environ.get("PARTYLINK_HTTP", "").lower() not in {"1", "true", "yes"}
    if use_https and not ensure_https_certificate(hosts):
        print("Could not create HTTPS certificate with openssl. Falling back to HTTP.", flush=True)
        use_https = False
    server = make_server(port, use_https, hosts)
    server.hosts = hosts
    server.use_https = use_https
    print_urls(port, use_https, hosts)
    server.serve_forever()


if __name__ == "__main__":
    main()
