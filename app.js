const joinForm = document.querySelector("#joinForm");
const nameInput = document.querySelector("#nameInput");
const roomInput = document.querySelector("#roomInput");
const roomCard = document.querySelector("#roomCard");
const roomCodeEl = document.querySelector("#roomCode");
const copyInviteBtn = document.querySelector("#copyInvite");
const serverDot = document.querySelector("#serverDot");
const serverStatus = document.querySelector("#serverStatus");
const micDot = document.querySelector("#micDot");
const micStatus = document.querySelector("#micStatus");
const liveCount = document.querySelector("#liveCount");
const connectionHint = document.querySelector("#connectionHint");
const peerList = document.querySelector("#peerList");
const memberList = document.querySelector("#memberList");
const peerTemplate = document.querySelector("#peerTemplate");
const muteBtn = document.querySelector("#muteBtn");
const deafenBtn = document.querySelector("#deafenBtn");
const leaveBtn = document.querySelector("#leaveBtn");
const outputVolume = document.querySelector("#outputVolume");
const pttMode = document.querySelector("#pttMode");
const roomMode = document.querySelector("#roomMode");
const meterBars = Array.from(document.querySelectorAll(".meter span"));

const palette = ["#42d392", "#48a7ff", "#ff5b8f", "#f5c15c", "#9b7cff", "#ff8a5b"];
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

let state = {
  room: "",
  clientId: "",
  name: "",
  muted: false,
  deafened: false,
  joined: false,
  lastSeq: 0,
  pollAbort: false
};

let rawLocalStream = null;
let localStream = null;
let audioContext = null;
let localAnalyser = null;
let noiseAnalyser = null;
let noiseGateGain = null;
let noiseGateFrame = 0;
let noiseFloorDb = -64;
let inviteBaseUrl = window.location.origin;
let pttHeld = false;
const peers = new Map();

const params = new URLSearchParams(window.location.search);
if (params.get("room")) {
  roomInput.value = params.get("room").toUpperCase();
}
nameInput.value = localStorage.getItem("partylink:name") || "";

function initials(name) {
  const clean = (name || "?").trim();
  return clean.slice(0, 2).toUpperCase();
}

function colorFor(id) {
  let sum = 0;
  for (const char of id || "") sum += char.charCodeAt(0);
  return palette[sum % palette.length];
}

function setServerStatus(text, mode = "offline") {
  serverStatus.textContent = text;
  serverDot.className = `dot ${mode === "online" ? "online" : mode === "warn" ? "warn" : ""}`;
}

function setMicStatus(text, enabled = false) {
  micStatus.textContent = text;
  micDot.className = `dot ${enabled ? "mic" : ""}`;
}

function localPeer() {
  return {
    id: state.clientId || "local",
    name: state.name || "你",
    muted: state.muted,
    deafened: state.deafened,
    local: true
  };
}

function upsertPeerRecord(peer) {
  const existing = peers.get(peer.id) || {};
  peers.set(peer.id, {
    ...existing,
    ...peer,
    connected: existing.connected || peer.local || false,
    speaking: existing.speaking || false
  });
  renderPeers();
}

function removePeer(peerId) {
  const record = peers.get(peerId);
  if (record?.pc) {
    record.pc.close();
  }
  if (record?.audio) {
    record.audio.remove();
  }
  peers.delete(peerId);
  renderPeers();
}

function renderPeers() {
  peerList.textContent = "";
  memberList.textContent = "";

  const allPeers = state.joined ? [localPeer(), ...Array.from(peers.values()).filter((peer) => !peer.local)] : [];
  liveCount.textContent = `${allPeers.length} 在线`;
  roomMode.textContent = state.joined ? "房内语音" : "未连接";

  for (const peer of allPeers) {
    const node = peerTemplate.content.firstElementChild.cloneNode(true);
    const avatar = node.querySelector(".avatar");
    const name = node.querySelector("strong");
    const status = node.querySelector("span");

    avatar.textContent = initials(peer.local ? "你" : peer.name);
    avatar.style.background = colorFor(peer.id);
    name.textContent = peer.local ? `${peer.name} (你)` : peer.name;
    status.textContent = peer.muted
      ? "麦克风静音"
      : peer.connected || peer.local
        ? peer.speaking
          ? "正在说话"
          : "已连接"
        : "连接中";

    node.classList.toggle("speaking", Boolean(peer.speaking));
    node.classList.toggle("muted", Boolean(peer.muted));
    peerList.appendChild(node);

    const member = document.createElement("div");
    member.className = "member";
    const smallAvatar = document.createElement("div");
    smallAvatar.className = "avatar";
    smallAvatar.style.background = colorFor(peer.id);
    smallAvatar.textContent = initials(peer.local ? "你" : peer.name);
    const text = document.createElement("div");
    text.innerHTML = `<strong></strong><span></span>`;
    text.querySelector("strong").textContent = peer.local ? `${peer.name} (你)` : peer.name;
    text.querySelector("span").textContent = peer.deafened ? "耳机静音" : peer.muted ? "麦克风静音" : "在线";
    member.append(smallAvatar, text);
    memberList.appendChild(member);
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function refreshInviteBaseUrl() {
  try {
    const res = await fetch("/api/info");
    if (!res.ok) return;
    const info = await res.json();
    const host = window.location.hostname;
    const openedLocally = host === "127.0.0.1" || host === "localhost";
    if (openedLocally && info.lanUrls?.length) {
      inviteBaseUrl = info.lanUrls[0];
    } else if (info.publicUrl?.startsWith("https://")) {
      inviteBaseUrl = info.publicUrl;
    } else {
      inviteBaseUrl = window.location.origin;
    }
  } catch (error) {
    inviteBaseUrl = window.location.origin;
  }
}

async function startMic() {
  if (!window.isSecureContext) {
    throw new Error("浏览器需要 HTTPS 页面才能开启麦克风，请使用服务器打印的 https:// 邀请地址。");
  }
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  };
  rawLocalStream = await navigator.mediaDevices.getUserMedia(constraints);
  audioContext = new AudioContext();
  localStream = buildCleanMicStream(rawLocalStream);
  watchNoiseGate();
  watchLocalMeter();
  setMicStatus("麦克风已开启", true);
}

function buildCleanMicStream(stream) {
  const source = audioContext.createMediaStreamSource(stream);
  const highpass = audioContext.createBiquadFilter();
  const lowpass = audioContext.createBiquadFilter();
  const compressor = audioContext.createDynamicsCompressor();
  const destination = audioContext.createMediaStreamDestination();

  highpass.type = "highpass";
  highpass.frequency.value = 120;
  highpass.Q.value = 0.7;

  lowpass.type = "lowpass";
  lowpass.frequency.value = 7800;
  lowpass.Q.value = 0.7;

  compressor.threshold.value = -34;
  compressor.knee.value = 18;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.18;

  noiseAnalyser = audioContext.createAnalyser();
  noiseAnalyser.fftSize = 1024;
  noiseGateGain = audioContext.createGain();
  noiseGateGain.gain.value = 1;
  localAnalyser = audioContext.createAnalyser();
  localAnalyser.fftSize = 128;

  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(noiseAnalyser);
  compressor.connect(noiseGateGain);
  noiseGateGain.connect(localAnalyser);
  localAnalyser.connect(destination);

  return destination.stream;
}

function dbFromTimeDomain(data) {
  let sum = 0;
  for (const sample of data) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / data.length) || 0.000001;
  return 20 * Math.log10(rms);
}

function watchNoiseGate() {
  if (!noiseAnalyser || !noiseGateGain) return;
  const data = new Float32Array(noiseAnalyser.fftSize);

  function tick() {
    if (!noiseAnalyser || !noiseGateGain || !audioContext) return;
    noiseAnalyser.getFloatTimeDomainData(data);
    const db = dbFromTimeDomain(data);
    const strongNoiseReduction = noiseToggle.checked;

    if (strongNoiseReduction && db < noiseFloorDb + 8) {
      noiseFloorDb = noiseFloorDb * 0.985 + db * 0.015;
    }

    const openDb = Math.max(-52, noiseFloorDb + 10);
    const closeDb = openDb - 6;
    const currentlyOpen = noiseGateGain.gain.value > 0.3;
    const shouldOpen = !strongNoiseReduction || (currentlyOpen ? db > closeDb : db > openDb);
    const targetGain = shouldOpen ? 1 : 0.035;
    const timeConstant = shouldOpen ? 0.012 : 0.11;
    noiseGateGain.gain.setTargetAtTime(targetGain, audioContext.currentTime, timeConstant);
    noiseGateFrame = requestAnimationFrame(tick);
  }

  tick();
}

function watchLocalMeter() {
  const data = new Uint8Array(localAnalyser.frequencyBinCount);
  function tick() {
    if (!localAnalyser) return;
    localAnalyser.getByteFrequencyData(data);
    const avg = data.reduce((sum, value) => sum + value, 0) / data.length;
    const level = Math.min(1, avg / 80);
    meterBars.forEach((bar, index) => {
      const height = 8 + Math.max(0.08, level - index * 0.12) * 36;
      bar.style.height = `${height}px`;
    });
    const localIsSpeaking = level > 0.28 && !state.muted;
    const local = peers.get(state.clientId);
    if (local && local.speaking !== localIsSpeaking) {
      local.speaking = localIsSpeaking;
      renderPeers();
    }
    requestAnimationFrame(tick);
  }
  tick();
}

function applyMuteState() {
  const pttActive = pttMode.value === "space";
  const shouldEnable = !state.muted && (!pttActive || pttHeld);
  if (rawLocalStream) {
    rawLocalStream.getAudioTracks().forEach((track) => {
      track.enabled = shouldEnable;
    });
  }
  if (localStream) {
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = shouldEnable;
    });
  }
  muteBtn.classList.toggle("active", !state.muted);
  deafenBtn.classList.toggle("active", !state.deafened);
  setMicStatus(state.muted ? "麦克风静音" : pttActive && !pttHeld ? "按住空格说话" : "麦克风已开启", !state.muted);
  upsertPeerRecord(localPeer());
}

function applyNoiseConstraints() {
  if (!rawLocalStream) return;
  rawLocalStream.getAudioTracks().forEach((track) => {
    track.applyConstraints({
      echoCancellation: true,
      noiseSuppression: noiseToggle.checked,
      autoGainControl: true
    }).catch(() => {});
  });
}

function applyOutputVolume() {
  const volume = state.deafened ? 0 : Number(outputVolume.value) / 100;
  for (const peer of peers.values()) {
    if (peer.audio) {
      peer.audio.volume = volume;
      peer.audio.muted = state.deafened;
    }
  }
}

async function sendSignal(to, type, payload) {
  await api("/api/send", {
    room: state.room,
    from: state.clientId,
    to,
    type,
    payload
  });
}

function createPeerConnection(peerId, polite) {
  const current = peers.get(peerId) || {};
  if (current.pc) return current.pc;

  const pc = new RTCPeerConnection(rtcConfig);
  current.pc = pc;
  current.polite = polite;
  peers.set(peerId, current);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(peerId, "ice", event.candidate).catch(console.error);
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    let audio = current.audio;
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
      current.audio = audio;
    }
    audio.srcObject = stream;
    current.connected = true;
    setupRemoteSpeaking(peerId, stream);
    applyOutputVolume();
    renderPeers();
  };

  pc.onconnectionstatechange = () => {
    current.connected = ["connected", "completed"].includes(pc.connectionState);
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      current.connected = false;
    }
    renderPeers();
  };

  return pc;
}

function setupRemoteSpeaking(peerId, stream) {
  if (!audioContext) return;
  const peer = peers.get(peerId);
  if (peer?.remoteAnalyser) return;

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 128;
  source.connect(analyser);
  peer.remoteAnalyser = analyser;
  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    const record = peers.get(peerId);
    if (!record || record.remoteAnalyser !== analyser) return;
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((sum, value) => sum + value, 0) / data.length;
    const speaking = avg > 24 && !record.muted;
    if (record.speaking !== speaking) {
      record.speaking = speaking;
      renderPeers();
    }
    requestAnimationFrame(tick);
  }
  tick();
}

async function callPeer(peer) {
  upsertPeerRecord(peer);
  const pc = createPeerConnection(peer.id, false);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal(peer.id, "offer", pc.localDescription);
}

async function handleSignal(message) {
  const from = message.from;
  if (!from || from === state.clientId) return;

  const record = peers.get(from) || { id: from, name: "队友" };
  peers.set(from, record);
  const pc = createPeerConnection(from, true);

  if (message.type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal(from, "answer", pc.localDescription);
  }

  if (message.type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
  }

  if (message.type === "ice") {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(message.payload));
    } catch (error) {
      console.warn("ICE candidate ignored", error);
    }
  }
}

async function poll() {
  while (state.joined && !state.pollAbort) {
    try {
      const res = await fetch(`/api/poll?room=${encodeURIComponent(state.room)}&clientId=${encodeURIComponent(state.clientId)}&after=${state.lastSeq}`);
      if (!res.ok) throw new Error("Polling failed");
      const data = await res.json();
      for (const message of data.messages) {
        state.lastSeq = Math.max(state.lastSeq, message.seq);
        if (message.type === "peer-joined") {
          upsertPeerRecord(message.peer);
        } else if (message.type === "peer-left") {
          removePeer(message.from);
        } else if (message.type === "peer-state") {
          upsertPeerRecord(message.peer);
        } else {
          await handleSignal(message);
        }
      }
      setServerStatus("信令在线", "online");
    } catch (error) {
      setServerStatus("正在重连信令", "warn");
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
}

async function joinRoom(event) {
  event.preventDefault();
  if (state.joined) return;

  const name = nameInput.value.trim() || `Player-${Math.floor(Math.random() * 90 + 10)}`;
  localStorage.setItem("partylink:name", name);
  setServerStatus("正在进入房间", "warn");

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风权限");
    }
    await startMic();
    const data = await api("/api/join", {
      name,
      room: roomInput.value.trim().toUpperCase()
    });

    state = {
      ...state,
      room: data.room,
      clientId: data.clientId,
      name,
      joined: true,
      pollAbort: false
    };

    roomCodeEl.textContent = state.room;
    roomCard.hidden = false;
    roomInput.value = state.room;
    window.history.replaceState(null, "", `/?room=${encodeURIComponent(state.room)}`);
    await refreshInviteBaseUrl();
    setServerStatus("信令在线", "online");
    connectionHint.textContent = "朋友加入后会自动连麦。复制邀请链接发给队友即可。";
    muteBtn.disabled = false;
    deafenBtn.disabled = false;
    leaveBtn.disabled = false;

    upsertPeerRecord(localPeer());
    applyMuteState();
    applyOutputVolume();
    poll();

    for (const peer of data.peers) {
      await callPeer(peer);
    }
  } catch (error) {
    console.error(error);
    setServerStatus(error.message || "进入失败", "warn");
    setMicStatus("麦克风未开启", false);
  }
}

async function leaveRoom() {
  if (!state.joined) return;
  state.pollAbort = true;
  await api("/api/leave", { room: state.room, clientId: state.clientId }).catch(() => {});
  for (const id of Array.from(peers.keys())) {
    removePeer(id);
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  if (rawLocalStream) {
    rawLocalStream.getTracks().forEach((track) => track.stop());
  }
  if (noiseGateFrame) {
    cancelAnimationFrame(noiseGateFrame);
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
  }
  rawLocalStream = null;
  localStream = null;
  audioContext = null;
  localAnalyser = null;
  noiseAnalyser = null;
  noiseGateGain = null;
  noiseGateFrame = 0;
  noiseFloorDb = -64;
  state = {
    room: "",
    clientId: "",
    name: state.name,
    muted: false,
    deafened: false,
    joined: false,
    lastSeq: 0,
    pollAbort: false
  };
  roomCard.hidden = true;
  muteBtn.disabled = true;
  deafenBtn.disabled = true;
  leaveBtn.disabled = true;
  setServerStatus("已离开房间", "offline");
  setMicStatus("麦克风未开启", false);
  connectionHint.textContent = "创建房间后，邀请朋友打开链接加入。";
  window.history.replaceState(null, "", "/");
  renderPeers();
}

async function publishState() {
  if (!state.joined) return;
  await api("/api/state", {
    room: state.room,
    clientId: state.clientId,
    muted: state.muted,
    deafened: state.deafened
  }).catch(console.error);
}

joinForm.addEventListener("submit", joinRoom);
muteBtn.addEventListener("click", () => {
  state.muted = !state.muted;
  applyMuteState();
  publishState();
});
deafenBtn.addEventListener("click", () => {
  state.deafened = !state.deafened;
  applyOutputVolume();
  applyMuteState();
  publishState();
});
leaveBtn.addEventListener("click", leaveRoom);
outputVolume.addEventListener("input", applyOutputVolume);
pttMode.addEventListener("change", applyMuteState);
noiseToggle.addEventListener("change", applyNoiseConstraints);
copyInviteBtn.addEventListener("click", async () => {
  await refreshInviteBaseUrl();
  const url = `${inviteBaseUrl}/?room=${encodeURIComponent(state.room)}`;
  await navigator.clipboard.writeText(url);
  connectionHint.textContent = "邀请链接已复制。";
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && pttMode.value === "space" && !event.repeat) {
    pttHeld = true;
    applyMuteState();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "Space" && pttMode.value === "space") {
    pttHeld = false;
    applyMuteState();
  }
});

window.addEventListener("beforeunload", () => {
  if (state.joined) {
    navigator.sendBeacon("/api/leave", JSON.stringify({ room: state.room, clientId: state.clientId }));
  }
});

refreshInviteBaseUrl();
renderPeers();
