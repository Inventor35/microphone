#!/usr/bin/env python3
import json
import hashlib
import hmac
import mimetypes
import os
import socket
import ssl
import subprocess
import secrets
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler


ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, "certs")
CERT_FILE = os.path.join(CERT_DIR, "partylink.crt")
KEY_FILE = os.path.join(CERT_DIR, "partylink.key")
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
DB_BACKEND = "postgres" if DATABASE_URL else "sqlite"
DB_FILE = os.environ.get("PARTYLINK_DB", os.path.join(ROOT, "partylink.db"))
SESSION_COOKIE = "partylink_session"
SESSION_TTL = 60 * 60 * 24 * 30
HASH_ITERATIONS = 210000
CHAT_HISTORY_LIMIT = 100
DEFAULT_STUN_URLS = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
TURN_REST_CACHE_TTL = 60 * 5
ALLOWED_EMOJIS = {"😂", "🔥", "👍", "🎯", "💀", "👏", "❤️", "😮", "😎", "😭"}
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/app.js": "app.js",
    "/assets/gaming-room-bg.jpg": os.path.join("assets", "gaming-room-bg.jpg"),
}

rooms = {}
condition = threading.Condition()
db_lock = threading.Lock()
turn_rest_lock = threading.Lock()
turn_rest_cache = {"expiresAt": 0, "iceServers": []}
next_seq = 1
psycopg = None
pg_dict_row = None
DB_INTEGRITY_ERRORS = (sqlite3.IntegrityError,)

if DB_BACKEND == "postgres":
    try:
        import psycopg
        from psycopg.rows import dict_row as pg_dict_row
    except ImportError as exc:
        raise RuntimeError(
            "DATABASE_URL is set, but psycopg is not installed. Run `pip install -r requirements.txt`."
        ) from exc
    DB_INTEGRITY_ERRORS = (sqlite3.IntegrityError, psycopg.IntegrityError)


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


def env_list(name, fallback=""):
    raw = os.environ.get(name, fallback)
    return [item.strip() for item in raw.split(",") if item.strip()]


def is_turn_server(server):
    urls = server.get("urls", [])
    if isinstance(urls, str):
        urls = [urls]
    return any(str(url).lower().startswith(("turn:", "turns:")) for url in urls)


def normalized_ice_server(server):
    if not isinstance(server, dict) or not server.get("urls"):
        return None
    result = {"urls": server["urls"]}
    for key in ("username", "credential", "credentialType"):
        if server.get(key):
            result[key] = server[key]
    return result


def turn_rest_ice_servers():
    rest_url = os.environ.get("PARTYLINK_TURN_REST_URL", "").strip()
    if not rest_url:
        return []

    now = time.time()
    with turn_rest_lock:
        if turn_rest_cache["expiresAt"] > now:
            return [dict(server) for server in turn_rest_cache["iceServers"]]

    try:
        request = urllib.request.Request(
            rest_url,
            headers={"Accept": "application/json", "User-Agent": "PartyLink/1.0"},
        )
        with urllib.request.urlopen(request, timeout=6) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        print(f"Could not load TURN REST credentials: {exc}", flush=True)
        return []

    raw_servers = payload.get("iceServers") if isinstance(payload, dict) else payload
    if not isinstance(raw_servers, list):
        print("TURN REST response did not include an iceServers list.", flush=True)
        return []

    servers = []
    for server in raw_servers:
        normalized = normalized_ice_server(server)
        if normalized:
            servers.append(normalized)

    with turn_rest_lock:
        turn_rest_cache["expiresAt"] = now + TURN_REST_CACHE_TTL
        turn_rest_cache["iceServers"] = servers

    return [dict(server) for server in servers]


def rtc_config():
    rest_servers = turn_rest_ice_servers()
    if rest_servers:
        ice_servers = rest_servers
        turn_configured = any(is_turn_server(server) for server in ice_servers)
    else:
        ice_servers = []
        stun_urls = env_list("PARTYLINK_STUN_URLS", DEFAULT_STUN_URLS)
        if stun_urls:
            ice_servers.append({"urls": stun_urls})

        turn_urls = env_list("PARTYLINK_TURN_URLS")
        turn_username = os.environ.get("PARTYLINK_TURN_USERNAME", "").strip()
        turn_credential = os.environ.get("PARTYLINK_TURN_CREDENTIAL", "").strip()
        turn_configured = bool(turn_urls and turn_username and turn_credential)
        if turn_configured:
            ice_servers.append(
                {
                    "urls": turn_urls,
                    "username": turn_username,
                    "credential": turn_credential,
                }
            )

    policy = os.environ.get("PARTYLINK_ICE_TRANSPORT_POLICY", "all").strip().lower()
    if policy not in {"all", "relay"}:
        policy = "all"

    return {
        "iceServers": ice_servers,
        "iceTransportPolicy": policy,
        "iceCandidatePoolSize": 4,
        "usingTurn": turn_configured,
    }


def postgres_query(query):
    return query.replace("?", "%s")


class DbConnection:
    def __init__(self):
        self.raw = None

    def __enter__(self):
        if DB_BACKEND == "postgres":
            self.raw = psycopg.connect(DATABASE_URL, row_factory=pg_dict_row)
        else:
            self.raw = sqlite3.connect(DB_FILE)
            self.raw.row_factory = sqlite3.Row
            self.raw.execute("PRAGMA foreign_keys = ON")
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            if exc_type:
                self.raw.rollback()
            else:
                self.raw.commit()
        finally:
            self.raw.close()
        return False

    def execute(self, query, params=()):
        if DB_BACKEND == "postgres":
            return self.raw.execute(postgres_query(query), params)
        return self.raw.execute(query, params)


def db_connection():
    return DbConnection()


def init_db():
    if DB_BACKEND == "sqlite":
        db_dir = os.path.dirname(DB_FILE)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
    with db_lock, db_connection() as conn:
        if DB_BACKEND == "postgres":
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at DOUBLE PRECISION NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    created_at DOUBLE PRECISION NOT NULL,
                    expires_at DOUBLE PRECISION NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS friendships (
                    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    user_a_id INTEGER NOT NULL,
                    user_b_id INTEGER NOT NULL,
                    requester_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    created_at DOUBLE PRECISION NOT NULL,
                    updated_at DOUBLE PRECISION NOT NULL,
                    UNIQUE (user_a_id, user_b_id),
                    CHECK (user_a_id < user_b_id),
                    FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS room_messages (
                    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    room_code TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    sender_name TEXT NOT NULL,
                    message_type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at DOUBLE PRECISION NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username))")
        else:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    display_name TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS friendships (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_a_id INTEGER NOT NULL,
                    user_b_id INTEGER NOT NULL,
                    requester_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE (user_a_id, user_b_id),
                    CHECK (user_a_id < user_b_id),
                    FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS room_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_code TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    sender_name TEXT NOT NULL,
                    message_type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships(user_a_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_room_messages_room_id ON room_messages(room_code, id)")


def normalize_username(username):
    return "".join(ch for ch in username.strip().lower() if ch.isalnum() or ch in {"_", "-"})


def public_user(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "displayName": row["display_name"],
    }


def hash_password(password, salt_hex=None):
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, HASH_ITERATIONS)
    return salt.hex(), digest.hex()


def verify_password(password, salt_hex, expected_hex):
    _, actual_hex = hash_password(password, salt_hex)
    return hmac.compare_digest(actual_hex, expected_hex)


def hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db_lock, db_connection() as conn:
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (hash_token(token), user_id, now, now + SESSION_TTL),
        )
    return token


def load_user_from_token(token):
    if not token:
        return None
    now = time.time()
    with db_lock, db_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        row = conn.execute(
            """
            SELECT users.id, users.username, users.display_name
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at >= ?
            """,
            (hash_token(token), now),
        ).fetchone()
    return row


def delete_session(token):
    if not token:
        return
    with db_lock, db_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))


def friendship_pair(first_id, second_id):
    return (first_id, second_id) if first_id < second_id else (second_id, first_id)


def online_user_ids():
    with condition:
        return {
            peer.get("userId")
            for room in rooms.values()
            for peer in room["peers"].values()
            if peer.get("userId")
        }


def friend_user_from_row(row, user_id, online_ids):
    prefix = "a" if row["b_id"] == user_id else "b"
    friend_id = row[f"{prefix}_id"]
    return {
        "friendshipId": row["id"],
        "id": friend_id,
        "username": row[f"{prefix}_username"],
        "displayName": row[f"{prefix}_display_name"],
        "online": friend_id in online_ids,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def friend_data_for_user(user_id):
    online_ids = online_user_ids()
    with db_lock, db_connection() as conn:
        rows = conn.execute(
            """
            SELECT friendships.id,
                   friendships.user_a_id,
                   friendships.user_b_id,
                   friendships.requester_id,
                   friendships.status,
                   friendships.created_at,
                   friendships.updated_at,
                   ua.id AS a_id,
                   ua.username AS a_username,
                   ua.display_name AS a_display_name,
                   ub.id AS b_id,
                   ub.username AS b_username,
                   ub.display_name AS b_display_name
            FROM friendships
            JOIN users ua ON ua.id = friendships.user_a_id
            JOIN users ub ON ub.id = friendships.user_b_id
            WHERE friendships.user_a_id = ? OR friendships.user_b_id = ?
            ORDER BY friendships.updated_at DESC
            """,
            (user_id, user_id),
        ).fetchall()

    friends = []
    incoming = []
    outgoing = []
    for row in rows:
        item = friend_user_from_row(row, user_id, online_ids)
        if row["status"] == "accepted":
            friends.append(item)
        elif row["status"] == "pending" and row["requester_id"] == user_id:
            outgoing.append(item)
        elif row["status"] == "pending":
            incoming.append(item)

    friends.sort(key=lambda item: (not item["online"], item["displayName"].lower()))
    incoming.sort(key=lambda item: item["updatedAt"], reverse=True)
    outgoing.sort(key=lambda item: item["updatedAt"], reverse=True)
    return {"friends": friends, "incoming": incoming, "outgoing": outgoing}


def save_room_message(room_code, user_id, sender_name, message_type, content):
    now = time.time()
    with db_lock, db_connection() as conn:
        conn.execute(
            """
            INSERT INTO room_messages (room_code, user_id, sender_name, message_type, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (room_code, user_id, sender_name[:24], message_type, content, now),
        )
        conn.execute(
            """
            DELETE FROM room_messages
            WHERE room_code = ?
              AND id NOT IN (
                SELECT id
                FROM room_messages
                WHERE room_code = ?
                ORDER BY id DESC
                LIMIT ?
              )
            """,
            (room_code, room_code, CHAT_HISTORY_LIMIT),
        )


def load_room_history(room_code):
    with db_lock, db_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, user_id, sender_name, message_type, content, created_at
            FROM room_messages
            WHERE room_code = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (room_code, CHAT_HISTORY_LIMIT),
        ).fetchall()

    history = []
    for row in reversed(rows):
        item = {
            "id": row["id"],
            "userId": row["user_id"],
            "name": row["sender_name"],
            "kind": "emoji" if row["message_type"] == "emoji" else "text",
            "sentAt": row["created_at"],
        }
        if row["message_type"] == "emoji":
            item["emoji"] = row["content"]
        else:
            item["text"] = row["content"]
        history.append(item)
    return history


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

    def cookies(self):
        result = {}
        raw = self.headers.get("Cookie", "")
        for item in raw.split(";"):
            if "=" in item:
                key, value = item.split("=", 1)
                result[key.strip()] = urllib.parse.unquote(value.strip())
        return result

    def session_token(self):
        return self.cookies().get(SESSION_COOKIE, "")

    def current_user(self):
        return load_user_from_token(self.session_token())

    def require_user(self):
        user = self.current_user()
        if not user:
            self.send_json(401, {"error": "请先登录账号"})
            return None
        return user

    def set_session_cookie(self, token):
        secure = self.request_origin().startswith("https://")
        parts = [
            f"{SESSION_COOKIE}={urllib.parse.quote(token)}",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            f"Max-Age={SESSION_TTL}",
        ]
        if secure:
            parts.append("Secure")
        self.send_header("Set-Cookie", "; ".join(parts))

    def clear_session_cookie(self):
        parts = [
            f"{SESSION_COOKIE}=",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=0",
        ]
        if self.request_origin().startswith("https://"):
            parts.append("Secure")
        self.send_header("Set-Cookie", "; ".join(parts))

    def send_auth_json(self, status, payload, token=None, clear_cookie=False):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if token:
            self.set_session_cookie(token)
        if clear_cookie:
            self.clear_session_cookie()
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

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
        if parsed.path == "/api/me":
            self.handle_me()
            return
        if parsed.path == "/api/friends":
            self.handle_friends()
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
            if parsed.path == "/api/register":
                self.handle_register()
            elif parsed.path == "/api/login":
                self.handle_login()
            elif parsed.path == "/api/logout":
                self.handle_logout()
            elif parsed.path == "/api/friends/request":
                self.handle_friend_request()
            elif parsed.path == "/api/friends/action":
                self.handle_friend_action()
            elif parsed.path == "/api/join":
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

    def handle_me(self):
        self.send_json(200, {"user": public_user(self.current_user())})

    def handle_friends(self):
        user = self.require_user()
        if not user:
            return
        self.send_json(200, friend_data_for_user(user["id"]))

    def handle_register(self):
        data = self.read_json()
        username = normalize_username(str(data.get("username", "")))
        display_name = str(data.get("displayName", "")).strip()[:24] or username
        password = str(data.get("password", ""))

        if len(username) < 3:
            self.send_json(400, {"error": "用户名至少需要 3 个字符，可用字母、数字、下划线或短横线"})
            return
        if len(password) < 8:
            self.send_json(400, {"error": "密码至少需要 8 个字符"})
            return
        if len(display_name) < 1:
            self.send_json(400, {"error": "显示名不能为空"})
            return

        salt_hex, password_hex = hash_password(password)
        try:
            with db_lock, db_connection() as conn:
                insert_sql = """
                INSERT INTO users (username, display_name, password_salt, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
                """
                if DB_BACKEND == "postgres":
                    insert_sql += " RETURNING id"
                cursor = conn.execute(insert_sql, (username, display_name, salt_hex, password_hex, time.time()))
                user_id = cursor.fetchone()["id"] if DB_BACKEND == "postgres" else cursor.lastrowid
                user = conn.execute(
                    "SELECT id, username, display_name FROM users WHERE id = ?",
                    (user_id,),
                ).fetchone()
        except DB_INTEGRITY_ERRORS:
            self.send_json(409, {"error": "这个用户名已经被注册"})
            return

        token = create_session(user["id"])
        self.send_auth_json(200, {"user": public_user(user)}, token=token)

    def handle_login(self):
        data = self.read_json()
        username = normalize_username(str(data.get("username", "")))
        password = str(data.get("password", ""))
        with db_lock, db_connection() as conn:
            user = conn.execute(
                "SELECT id, username, display_name, password_salt, password_hash FROM users WHERE username = ?",
                (username,),
            ).fetchone()

        if not user or not verify_password(password, user["password_salt"], user["password_hash"]):
            self.send_json(401, {"error": "用户名或密码不正确"})
            return

        token = create_session(user["id"])
        self.send_auth_json(200, {"user": public_user(user)}, token=token)

    def handle_logout(self):
        delete_session(self.session_token())
        self.send_auth_json(200, {"ok": True}, clear_cookie=True)

    def handle_friend_request(self):
        user = self.require_user()
        if not user:
            return
        data = self.read_json()
        username = normalize_username(str(data.get("username", "")))
        if len(username) < 3:
            self.send_json(400, {"error": "请输入正确的好友用户名"})
            return

        now = time.time()
        with db_lock, db_connection() as conn:
            target = conn.execute(
                "SELECT id, username, display_name FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            if not target:
                self.send_json(404, {"error": "没有找到这个用户"})
                return
            if target["id"] == user["id"]:
                self.send_json(400, {"error": "不能添加自己为好友"})
                return

            user_a_id, user_b_id = friendship_pair(user["id"], target["id"])
            existing = conn.execute(
                """
                SELECT id, requester_id, status
                FROM friendships
                WHERE user_a_id = ? AND user_b_id = ?
                """,
                (user_a_id, user_b_id),
            ).fetchone()

            if existing and existing["status"] == "accepted":
                self.send_json(200, {"message": "你们已经是好友"})
                return
            if existing and existing["requester_id"] == user["id"]:
                self.send_json(200, {"message": "好友请求已经发送过了"})
                return
            if existing:
                conn.execute(
                    """
                    UPDATE friendships
                    SET status = 'accepted', updated_at = ?
                    WHERE id = ?
                    """,
                    (now, existing["id"]),
                )
                self.send_json(200, {"message": "对方之前发过请求，已自动成为好友"})
                return

            conn.execute(
                """
                INSERT INTO friendships (user_a_id, user_b_id, requester_id, status, created_at, updated_at)
                VALUES (?, ?, ?, 'pending', ?, ?)
                """,
                (user_a_id, user_b_id, user["id"], now, now),
            )
        self.send_json(200, {"message": "好友请求已发送"})

    def handle_friend_action(self):
        user = self.require_user()
        if not user:
            return
        data = self.read_json()
        action = str(data.get("action", "")).strip().lower()
        try:
            friendship_id = int(data.get("friendshipId", 0))
        except (TypeError, ValueError):
            self.send_json(400, {"error": "好友请求不存在"})
            return
        if friendship_id <= 0:
            self.send_json(400, {"error": "好友请求不存在"})
            return

        now = time.time()
        with db_lock, db_connection() as conn:
            friendship = conn.execute(
                """
                SELECT id, user_a_id, user_b_id, requester_id, status
                FROM friendships
                WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)
                """,
                (friendship_id, user["id"], user["id"]),
            ).fetchone()
            if not friendship:
                self.send_json(404, {"error": "没有找到这条好友记录"})
                return

            is_requester = friendship["requester_id"] == user["id"]
            if action == "accept":
                if friendship["status"] != "pending" or is_requester:
                    self.send_json(400, {"error": "不能接受这条好友请求"})
                    return
                conn.execute(
                    "UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?",
                    (now, friendship_id),
                )
                self.send_json(200, {"message": "已成为好友"})
                return

            if action == "decline":
                if friendship["status"] != "pending" or is_requester:
                    self.send_json(400, {"error": "不能拒绝这条好友请求"})
                    return
                conn.execute("DELETE FROM friendships WHERE id = ?", (friendship_id,))
                self.send_json(200, {"message": "已拒绝好友请求"})
                return

            if action == "cancel":
                if friendship["status"] != "pending" or not is_requester:
                    self.send_json(400, {"error": "不能取消这条好友请求"})
                    return
                conn.execute("DELETE FROM friendships WHERE id = ?", (friendship_id,))
                self.send_json(200, {"message": "已取消好友请求"})
                return

            if action == "remove":
                if friendship["status"] != "accepted":
                    self.send_json(400, {"error": "你们还不是好友"})
                    return
                conn.execute("DELETE FROM friendships WHERE id = ?", (friendship_id,))
                self.send_json(200, {"message": "已删除好友"})
                return

        self.send_json(400, {"error": "未知的好友操作"})

    def handle_join(self):
        user = self.require_user()
        if not user:
            return
        data = self.read_json()
        name = str(data.get("name", "")).strip()[:24] or user["display_name"]
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
                "userId": user["id"],
                "name": name,
                "muted": False,
                "deafened": False,
                "joinedAt": time.time(),
                "messages": [],
            }
            room["peers"][client_id] = peer
            broadcast(room_code, {"type": "peer-joined", "peer": public_peer(peer)}, exclude=client_id)
            condition.notify_all()

        self.send_json(
            200,
            {
                "room": room_code,
                "clientId": client_id,
                "peers": peers,
                "history": load_room_history(room_code),
            },
        )

    def handle_send(self):
        user = self.require_user()
        if not user:
            return
        data = self.read_json()
        room_code = str(data.get("room", "")).strip().upper()
        sender = str(data.get("from", ""))
        target = data.get("to")
        message_type = str(data.get("type", ""))
        payload = data.get("payload", {})
        history_content = None

        with condition:
            room = rooms.get(room_code)
            if not room or sender not in room["peers"]:
                self.send_json(404, {"error": "Room or sender not found"})
                return
            if room["peers"][sender].get("userId") != user["id"]:
                self.send_json(403, {"error": "不能使用其他账号的房间连接"})
                return

            peer = room["peers"][sender]
            if message_type == "chat":
                text = str(payload.get("text", "")).strip()
                if not text:
                    self.send_json(400, {"error": "消息不能为空"})
                    return
                history_content = text[:240]
                payload = {"text": history_content, "name": peer["name"]}
                target = None
            elif message_type == "emoji":
                emoji = str(payload.get("emoji", "")).strip()
                if emoji not in ALLOWED_EMOJIS:
                    self.send_json(400, {"error": "不支持这个表情"})
                    return
                history_content = emoji
                payload = {"emoji": emoji, "name": peer["name"]}
                target = None

            body = {"type": message_type, "from": sender, "payload": payload}
            if target:
                push_message(room_code, str(target), body)
            else:
                broadcast(room_code, body, exclude=sender)
                if message_type in {"chat", "emoji"} and history_content:
                    save_room_message(room_code, user["id"], peer["name"], message_type, history_content)
            condition.notify_all()

        self.send_json(200, {"ok": True})

    def handle_state(self):
        user = self.require_user()
        if not user:
            return
        data = self.read_json()
        room_code = str(data.get("room", "")).strip().upper()
        client_id = str(data.get("clientId", ""))
        with condition:
            room = rooms.get(room_code)
            if not room or client_id not in room["peers"]:
                self.send_json(404, {"error": "Room or peer not found"})
                return
            if room["peers"][client_id].get("userId") != user["id"]:
                self.send_json(403, {"error": "不能修改其他账号的状态"})
                return
            peer = room["peers"][client_id]
            peer["muted"] = bool(data.get("muted", False))
            peer["deafened"] = bool(data.get("deafened", False))
            broadcast(room_code, {"type": "peer-state", "peer": public_peer(peer)}, exclude=client_id)
            condition.notify_all()
        self.send_json(200, {"ok": True})

    def handle_leave(self):
        user = self.require_user()
        if not user:
            return
        data = self.read_json()
        room_code = str(data.get("room", "")).strip().upper()
        client_id = str(data.get("clientId", ""))
        with condition:
            room = rooms.get(room_code)
            if room and client_id in room["peers"]:
                if room["peers"][client_id].get("userId") != user["id"]:
                    self.send_json(403, {"error": "不能移除其他账号的连接"})
                    return
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
                "rtcConfig": rtc_config(),
            },
        )

    def handle_poll(self, parsed):
        user = self.require_user()
        if not user:
            return
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
                if peer.get("userId") != user["id"]:
                    self.send_json(403, {"error": "不能读取其他账号的房间消息"})
                    return

                messages = [msg for msg in peer["messages"] if msg["seq"] > after]
                if messages or time.time() >= deadline:
                    break
                condition.wait(timeout=max(0.1, deadline - time.time()))

        self.send_json(200, {"messages": messages})


def main():
    init_db()
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
