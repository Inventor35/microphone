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
const authForm = document.querySelector("#authForm");
const authPanel = authForm;
const authUsername = document.querySelector("#authUsername");
const authDisplayName = document.querySelector("#authDisplayName");
const authPassword = document.querySelector("#authPassword");
const authMessage = document.querySelector("#authMessage");
const registerBtn = document.querySelector("#registerBtn");
const accountCard = document.querySelector("#accountCard");
const accountAvatar = document.querySelector("#accountAvatar");
const accountName = document.querySelector("#accountName");
const accountUsername = document.querySelector("#accountUsername");
const logoutBtn = document.querySelector("#logoutBtn");
const friendsPanel = document.querySelector("#friendsPanel");
const friendSummary = document.querySelector("#friendSummary");
const friendRefreshBtn = document.querySelector("#friendRefreshBtn");
const friendForm = document.querySelector("#friendForm");
const friendUsername = document.querySelector("#friendUsername");
const friendMessage = document.querySelector("#friendMessage");
const friendCount = document.querySelector("#friendCount");
const requestCount = document.querySelector("#requestCount");
const roomInviteCount = document.querySelector("#roomInviteCount");
const friendList = document.querySelector("#friendList");
const friendRequestList = document.querySelector("#friendRequestList");
const roomInviteList = document.querySelector("#roomInviteList");
const chatMessages = document.querySelector("#chatMessages");
const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const chatStatus = document.querySelector("#chatStatus");
const chatToggle = document.querySelector("#chatToggle");
const emojiBurstLayer = document.querySelector("#emojiBurstLayer");
const emojiButtons = Array.from(document.querySelectorAll("[data-emoji]"));

const CHAT_HISTORY_LIMIT = 100;
const ROOM_INVITE_POLL_MS = 8000;
const RTC_CONFIG_TTL_MS = 60000;
const palette = ["#42d392", "#48a7ff", "#ff5b8f", "#f5c15c", "#9b7cff", "#ff8a5b"];
let rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],
  iceCandidatePoolSize: 4
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
let rtcConfigFetchedAt = 0;
let pttHeld = false;
let currentUser = null;
let friendsState = { friends: [], incoming: [], outgoing: [] };
let roomInvitesState = [];
let roomInvitePollTimer = 0;
let chatItems = [];
let chatCollapsed = false;
let unreadChatCount = 0;
const peers = new Map();

function audioLevelForVolume() {
  return state.deafened ? 0 : Number(outputVolume.value) / 100;
}

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

function setChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  chatForm.querySelector("button").disabled = !enabled;
  emojiButtons.forEach((button) => {
    button.disabled = !enabled;
  });
  updateChatChrome();
}

function updateChatChrome() {
  const enabled = !chatInput.disabled;
  document.querySelector(".public-chat").classList.toggle("collapsed", chatCollapsed);
  chatToggle.textContent = chatCollapsed ? "+" : "−";
  chatToggle.title = chatCollapsed ? "展开公屏" : "收起公屏";
  chatToggle.setAttribute("aria-label", chatCollapsed ? "展开公屏" : "收起公屏");
  if (!enabled) {
    chatStatus.textContent = "等待入房";
  } else if (chatCollapsed && unreadChatCount > 0) {
    chatStatus.textContent = `${unreadChatCount} 条新消息`;
  } else {
    chatStatus.textContent = chatCollapsed ? "已收起" : "房内可见";
  }
}

function toggleChat() {
  chatCollapsed = !chatCollapsed;
  if (!chatCollapsed) {
    unreadChatCount = 0;
  }
  updateChatChrome();
}

function peerName(peerId, fallback = "队友") {
  if (peerId === state.clientId) return state.name || "你";
  return peers.get(peerId)?.name || fallback;
}

function isChatAtBottom() {
  return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight <= 24;
}

function renderChat({ forceBottom = false } = {}) {
  const wasEmpty = chatMessages.childElementCount === 0;
  const shouldStayAtBottom = forceBottom || wasEmpty || isChatAtBottom();
  const distanceFromBottom = chatMessages.scrollHeight - chatMessages.scrollTop;

  chatMessages.textContent = "";
  for (const item of chatItems.slice(-CHAT_HISTORY_LIMIT)) {
    const row = document.createElement("article");
    row.className = `chat-row ${item.mine ? "mine" : ""} ${item.kind === "emoji" ? "emoji-row" : ""}`;

    const meta = document.createElement("span");
    meta.className = "chat-meta";
    meta.textContent = item.mine ? "你" : item.name;

    const body = document.createElement("p");
    body.textContent = item.kind === "emoji" ? `${item.emoji}` : item.text;

    row.append(meta, body);
    chatMessages.appendChild(row);
  }
  if (shouldStayAtBottom) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } else {
    chatMessages.scrollTop = Math.max(0, chatMessages.scrollHeight - distanceFromBottom);
  }
}

function addChatItem(item) {
  chatItems.push({ id: `${Date.now()}-${Math.random()}`, ...item });
  if (chatItems.length > CHAT_HISTORY_LIMIT) {
    chatItems = chatItems.slice(-CHAT_HISTORY_LIMIT);
  }
  if (chatCollapsed && !item.mine) {
    unreadChatCount = Math.min(99, unreadChatCount + 1);
  }
  renderChat({ forceBottom: item.mine });
  updateChatChrome();
}

function loadChatHistory(history = []) {
  chatItems = history.slice(-CHAT_HISTORY_LIMIT).map((item) => ({
    id: `history-${item.id || `${item.sentAt || Date.now()}-${Math.random()}`}`,
    kind: item.kind === "emoji" ? "emoji" : "text",
    text: item.text || "",
    emoji: item.emoji || "",
    name: item.name || "队友",
    mine: Number(item.userId) === Number(currentUser?.id)
  }));
  renderChat({ forceBottom: true });
  updateChatChrome();
}

function burstEmoji(emoji, mine = false) {
  const node = document.createElement("div");
  node.className = `emoji-burst ${mine ? "mine" : ""}`;
  node.textContent = emoji;
  node.style.right = `${9 + Math.random() * 22}%`;
  node.style.animationDelay = `${Math.random() * 120}ms`;
  emojiBurstLayer.appendChild(node);
  window.setTimeout(() => node.remove(), 2300);
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
  document.querySelectorAll("audio[data-peer-id]").forEach((audio) => {
    if (audio.dataset.peerId === peerId) {
      audio.remove();
    }
  });
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

async function authRequest(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "操作失败");
  }
  return data;
}

async function getJson(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "读取失败");
  }
  return data;
}

function setAuthMessage(text, mode = "") {
  authMessage.textContent = text;
  authMessage.className = `auth-message ${mode}`;
}

function setFriendMessage(text, mode = "") {
  friendMessage.textContent = text;
  friendMessage.className = `friend-message ${mode}`;
}

function emptyFriendRow(text) {
  const row = document.createElement("div");
  row.className = "friend-empty";
  row.textContent = text;
  return row;
}

function friendActionButton(label, action, friendshipId = "", tone = "", extraData = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `friend-action ${tone}`;
  button.dataset.friendAction = action;
  if (friendshipId) {
    button.dataset.friendshipId = friendshipId;
  }
  Object.entries(extraData).forEach(([key, value]) => {
    button.dataset[key] = value;
  });
  button.textContent = label;
  return button;
}

function friendRow(user, statusText, actions = []) {
  const row = document.createElement("article");
  row.className = "friend-row";
  const avatar = document.createElement("div");
  avatar.className = "friend-avatar";
  avatar.style.background = colorFor(String(user.id));
  avatar.textContent = initials(user.displayName);

  const main = document.createElement("div");
  main.className = "friend-main";
  const name = document.createElement("strong");
  name.textContent = user.displayName;
  const meta = document.createElement("span");
  meta.textContent = statusText;
  main.append(name, meta);

  const actionWrap = document.createElement("div");
  actionWrap.className = "friend-actions";
  actions.forEach((action) => actionWrap.appendChild(action));

  row.append(avatar, main, actionWrap);
  return row;
}

function updateFriendSummary() {
  const friends = friendsState.friends || [];
  const incoming = friendsState.incoming || [];
  const outgoing = friendsState.outgoing || [];
  const pendingCount = incoming.length + outgoing.length;
  const inviteCount = roomInvitesState.length;
  const suffix = [
    pendingCount ? `${pendingCount} 个请求` : "",
    inviteCount ? `${inviteCount} 个邀请` : ""
  ].filter(Boolean).join(" · ");
  friendSummary.textContent = `${friends.length} 位好友${suffix ? ` · ${suffix}` : ""}`;
}

function renderFriends() {
  const friends = friendsState.friends || [];
  const incoming = friendsState.incoming || [];
  const outgoing = friendsState.outgoing || [];
  const pendingCount = incoming.length + outgoing.length;

  updateFriendSummary();
  friendCount.textContent = String(friends.length);
  requestCount.textContent = String(pendingCount);
  friendList.textContent = "";
  friendRequestList.textContent = "";

  if (!currentUser) {
    friendList.appendChild(emptyFriendRow("登录后显示好友"));
    friendRequestList.appendChild(emptyFriendRow("登录后显示请求"));
    return;
  }

  if (!friends.length) {
    friendList.appendChild(emptyFriendRow("还没有好友"));
  } else {
    friends.forEach((friend) => {
      const status = `@${friend.username} · ${friend.online ? "在线" : "离线"}`;
      const inviteButton = friendActionButton("邀请", "invite-room", "", "ok", { friendId: friend.id });
      inviteButton.disabled = !state.joined;
      inviteButton.title = state.joined ? "邀请好友加入当前房间" : "进入房间后才能邀请好友";
      friendList.appendChild(
        friendRow(friend, status, [
          inviteButton,
          friendActionButton("删除", "remove", friend.friendshipId, "danger")
        ])
      );
    });
  }

  if (!pendingCount) {
    friendRequestList.appendChild(emptyFriendRow("暂无好友请求"));
  }
  incoming.forEach((friend) => {
    friendRequestList.appendChild(
      friendRow(friend, `@${friend.username} 想加你`, [
        friendActionButton("同意", "accept", friend.friendshipId, "ok"),
        friendActionButton("拒绝", "decline", friend.friendshipId)
      ])
    );
  });
  outgoing.forEach((friend) => {
    friendRequestList.appendChild(
      friendRow(friend, `已发送给 @${friend.username}`, [
        friendActionButton("取消", "cancel", friend.friendshipId)
      ])
    );
  });
}

function renderRoomInvites() {
  const invites = roomInvitesState || [];
  updateFriendSummary();
  roomInviteCount.textContent = String(invites.length);
  roomInviteList.textContent = "";

  if (!currentUser) {
    roomInviteList.appendChild(emptyFriendRow("登录后显示邀请"));
    return;
  }

  if (!invites.length) {
    roomInviteList.appendChild(emptyFriendRow("暂无房间邀请"));
    return;
  }

  invites.forEach((invite) => {
    const inviter = {
      id: invite.inviterId,
      displayName: invite.inviterName || "好友",
      username: invite.inviterUsername || "friend"
    };
    const status = `@${inviter.username} 邀你进 ${invite.room}`;
    roomInviteList.appendChild(
      friendRow(inviter, status, [
        friendActionButton("加入", "accept-room-invite", "", "ok", { inviteId: invite.id }),
        friendActionButton("忽略", "decline-room-invite", "", "", { inviteId: invite.id })
      ])
    );
  });
}

async function loadFriends(silent = false) {
  if (!currentUser) {
    friendsState = { friends: [], incoming: [], outgoing: [] };
    renderFriends();
    return;
  }
  if (!silent) {
    setFriendMessage("正在同步好友...");
  }
  try {
    friendsState = await getJson("/api/friends");
    renderFriends();
    if (!silent) {
      setFriendMessage("");
    }
  } catch (error) {
    setFriendMessage(error.message, "error");
  }
}

async function loadRoomInvites(silent = false) {
  if (!currentUser) {
    roomInvitesState = [];
    renderRoomInvites();
    return;
  }
  try {
    const previousInviteIds = new Set(roomInvitesState.map((invite) => String(invite.id)));
    const data = await getJson("/api/room-invites");
    const nextInvites = data.invites || [];
    const newInvite = nextInvites.find((invite) => !previousInviteIds.has(String(invite.id)));
    roomInvitesState = nextInvites;
    renderRoomInvites();
    if (newInvite) {
      connectionHint.textContent = `${newInvite.inviterName || "好友"} 邀请你加入 ${newInvite.room}，在左侧房间邀请里点加入。`;
    }
  } catch (error) {
    if (!silent) {
      setFriendMessage(error.message, "error");
    }
  }
}

function stopRoomInvitePolling() {
  if (roomInvitePollTimer) {
    clearInterval(roomInvitePollTimer);
    roomInvitePollTimer = 0;
  }
}

function startRoomInvitePolling() {
  stopRoomInvitePolling();
  loadRoomInvites(true);
  roomInvitePollTimer = window.setInterval(() => {
    if (currentUser) {
      loadRoomInvites(true);
    }
  }, ROOM_INVITE_POLL_MS);
}

async function submitFriendRequest(event) {
  event.preventDefault();
  if (!currentUser) {
    setFriendMessage("请先登录账号", "error");
    return;
  }
  const username = friendUsername.value.trim();
  if (!username) {
    setFriendMessage("请输入好友用户名", "error");
    return;
  }
  setFriendMessage("正在发送请求...");
  try {
    const data = await authRequest("/api/friends/request", { username });
    friendUsername.value = "";
    setFriendMessage(data.message || "好友请求已发送", "ok");
    await loadFriends(true);
  } catch (error) {
    setFriendMessage(error.message, "error");
  }
}

async function runFriendAction(button) {
  const action = button.dataset.friendAction;
  const friendshipId = Number(button.dataset.friendshipId);
  if (!action || !friendshipId) return;
  button.disabled = true;
  try {
    const data = await authRequest("/api/friends/action", { action, friendshipId });
    setFriendMessage(data.message || "好友已更新", "ok");
    await loadFriends(true);
  } catch (error) {
    setFriendMessage(error.message, "error");
    button.disabled = false;
  }
}

async function inviteFriendToRoom(button) {
  const friendId = Number(button.dataset.friendId);
  if (!friendId) return;
  if (!state.joined) {
    setFriendMessage("先进入房间，再邀请好友", "error");
    return;
  }

  button.disabled = true;
  try {
    const data = await authRequest("/api/room-invites/send", {
      friendId,
      room: state.room
    });
    setFriendMessage(data.message || "房间邀请已发送", "ok");
    connectionHint.textContent = data.message || "房间邀请已发送。";
  } catch (error) {
    setFriendMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function joinRoomFromInvite(roomCode) {
  if (!roomCode) return;
  if (state.joined && state.room === roomCode) {
    setFriendMessage("你已经在这个房间里了", "ok");
    return;
  }
  if (state.joined) {
    await leaveRoom("正在加入好友邀请的房间...");
  }
  roomInput.value = roomCode;
  await joinRoom({ preventDefault() {} });
}

async function runRoomInviteAction(button) {
  const inviteId = Number(button.dataset.inviteId);
  if (!inviteId) return;
  const accept = button.dataset.friendAction === "accept-room-invite";

  button.disabled = true;
  try {
    const data = await authRequest("/api/room-invites/action", {
      inviteId,
      action: accept ? "accept" : "decline"
    });
    await loadRoomInvites(true);
    if (accept) {
      setFriendMessage("正在加入好友房间...", "ok");
      await joinRoomFromInvite(data.room);
    } else {
      setFriendMessage(data.message || "已忽略邀请", "ok");
    }
  } catch (error) {
    setFriendMessage(error.message, "error");
    button.disabled = false;
  }
}

function handleFriendActionClick(event) {
  const button = event.target.closest("[data-friend-action]");
  if (!button) return;
  const action = button.dataset.friendAction;
  if (action === "invite-room") {
    inviteFriendToRoom(button);
  } else if (action === "accept-room-invite" || action === "decline-room-invite") {
    runRoomInviteAction(button);
  } else {
    runFriendAction(button);
  }
}

function setJoinLocked(locked) {
  joinForm.classList.toggle("locked", locked);
  nameInput.disabled = locked;
  roomInput.disabled = locked;
  joinForm.querySelector("button[type='submit']").disabled = locked;
}

function setCurrentUser(user) {
  currentUser = user;
  authPanel.hidden = Boolean(user);
  accountCard.hidden = !user;
  friendsPanel.hidden = !user;
  setJoinLocked(!user);

  if (user) {
    accountAvatar.textContent = initials(user.displayName);
    accountAvatar.style.background = colorFor(String(user.id));
    accountName.textContent = user.displayName;
    accountUsername.textContent = `@${user.username}`;
    if (!nameInput.value.trim()) {
      nameInput.value = user.displayName;
    }
    localStorage.setItem("partylink:name", user.displayName);
    setAuthMessage("");
    setFriendMessage("");
    connectionHint.textContent = "账号已登录，可以创建房间或加入朋友房间。";
    loadFriends(true);
    startRoomInvitePolling();
  } else {
    stopRoomInvitePolling();
    accountName.textContent = "";
    accountUsername.textContent = "";
    friendUsername.value = "";
    friendsState = { friends: [], incoming: [], outgoing: [] };
    roomInvitesState = [];
    renderFriends();
    renderRoomInvites();
    setFriendMessage("");
    connectionHint.textContent = "请先登录账号，再创建房间或加入朋友房间。";
  }
}

async function loadCurrentUser() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    setCurrentUser(data.user);
  } catch (error) {
    setCurrentUser(null);
  }
}

async function submitLogin(event) {
  event.preventDefault();
  setAuthMessage("正在登录...");
  try {
    const data = await authRequest("/api/login", {
      username: authUsername.value,
      password: authPassword.value
    });
    authPassword.value = "";
    setCurrentUser(data.user);
    setAuthMessage("已登录", "ok");
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

async function submitRegister() {
  setAuthMessage("正在注册...");
  try {
    const data = await authRequest("/api/register", {
      username: authUsername.value,
      displayName: authDisplayName.value,
      password: authPassword.value
    });
    authPassword.value = "";
    setCurrentUser(data.user);
    setAuthMessage("注册成功", "ok");
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

async function logout() {
  if (state.joined) {
    await leaveRoom();
  }
  await authRequest("/api/logout").catch(() => {});
  setCurrentUser(null);
  setAuthMessage("已退出账号", "ok");
}

async function refreshInviteBaseUrl() {
  try {
    const res = await fetch("/api/info");
    if (!res.ok) return;
    const info = await res.json();
    updateRtcConfig(info.rtcConfig);
    rtcConfigFetchedAt = Date.now();
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

async function ensureRtcConfigFresh() {
  if (Date.now() - rtcConfigFetchedAt > RTC_CONFIG_TTL_MS) {
    await refreshInviteBaseUrl();
  }
}

function updateRtcConfig(config) {
  if (!config || !Array.isArray(config.iceServers) || !config.iceServers.length) return;
  rtcConfig = {
    iceServers: config.iceServers,
    iceCandidatePoolSize: Number(config.iceCandidatePoolSize) || 4
  };
  if (["all", "relay"].includes(config.iceTransportPolicy)) {
    rtcConfig.iceTransportPolicy = config.iceTransportPolicy;
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
      autoGainControl: { ideal: false },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      latency: { ideal: 0.02 }
    },
    video: false
  };
  rawLocalStream = await navigator.mediaDevices.getUserMedia(constraints);
  try {
    audioContext = new AudioContext({ latencyHint: "interactive" });
  } catch (error) {
    audioContext = new AudioContext();
  }
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
  highpass.frequency.value = 145;
  highpass.Q.value = 0.7;

  lowpass.type = "lowpass";
  lowpass.frequency.value = 6800;
  lowpass.Q.value = 0.7;

  compressor.threshold.value = -30;
  compressor.knee.value = 14;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.14;

  noiseAnalyser = audioContext.createAnalyser();
  noiseAnalyser.fftSize = 1024;
  noiseGateGain = audioContext.createGain();
  noiseGateGain.gain.value = 1;
  localAnalyser = audioContext.createAnalyser();
  localAnalyser.fftSize = 128;

  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(noiseAnalyser);
  lowpass.connect(noiseGateGain);
  noiseGateGain.connect(compressor);
  compressor.connect(localAnalyser);
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

    if (strongNoiseReduction && db < noiseFloorDb + 12) {
      noiseFloorDb = noiseFloorDb * 0.99 + db * 0.01;
    }

    const openDb = Math.max(-50, noiseFloorDb + 14);
    const closeDb = openDb - 8;
    const currentlyOpen = noiseGateGain.gain.value > 0.3;
    const shouldOpen = !strongNoiseReduction || (currentlyOpen ? db > closeDb : db > openDb);
    const targetGain = shouldOpen ? 1 : 0.01;
    const timeConstant = shouldOpen ? 0.009 : 0.16;
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
      autoGainControl: { ideal: false },
      channelCount: { ideal: 1 }
    }).catch(() => {});
  });
}

function applyOutputVolume() {
  const volume = audioLevelForVolume();
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

async function sendRoomEvent(type, payload) {
  if (!state.joined) return;
  await sendSignal(null, type, payload);
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (!state.joined) return;
  const text = chatInput.value.trim();
  if (!text) return;
  const clipped = text.slice(0, 240);
  chatInput.value = "";
  addChatItem({ kind: "text", text: clipped, name: state.name, mine: true });
  await sendRoomEvent("chat", { text: clipped, name: state.name }).catch(() => {
    addChatItem({ kind: "text", text: "消息发送失败", name: "系统", mine: false });
  });
}

async function sendEmoji(emoji) {
  if (!state.joined) return;
  addChatItem({ kind: "emoji", emoji, name: state.name, mine: true });
  burstEmoji(emoji, true);
  await sendRoomEvent("emoji", { emoji, name: state.name }).catch(() => {});
}

function handleRoomEvent(message) {
  const payload = message.payload || {};
  const name = peerName(message.from, payload.name || "队友");
  if (message.type === "chat") {
    const text = String(payload.text || "").trim();
    if (text) {
      addChatItem({ kind: "text", text, name, mine: message.from === state.clientId });
    }
  }
  if (message.type === "emoji") {
    const emoji = String(payload.emoji || "").trim();
    if (emoji) {
      addChatItem({ kind: "emoji", emoji, name, mine: message.from === state.clientId });
      burstEmoji(emoji, message.from === state.clientId);
    }
  }
}

function createPeerConnection(peerId, polite) {
  const current = peers.get(peerId) || {};
  current.pendingIce = current.pendingIce || [];
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
    if (event.track.kind !== "audio" || peerId === state.clientId) return;
    const stream = event.streams[0];
    if (!stream) return;
    let audio = current.audio;
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.controls = false;
      audio.dataset.peerId = peerId;
      document.body.appendChild(audio);
      current.audio = audio;
    }
    document.querySelectorAll("audio[data-peer-id]").forEach((node) => {
      if (node !== audio && node.dataset.peerId === peerId) {
        node.remove();
      }
    });
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    audio.volume = audioLevelForVolume();
    audio.muted = state.deafened;
    current.connected = true;
    setupRemoteSpeaking(peerId, stream);
    applyOutputVolume();
    audio.play().catch(() => {
      if (!current.playBlocked) {
        current.playBlocked = true;
        connectionHint.textContent = "浏览器拦截了队友声音，点一下页面后再试。";
      }
    });
    renderPeers();
  };

  pc.oniceconnectionstatechange = () => {
    current.iceState = pc.iceConnectionState;
    if (["connected", "completed"].includes(pc.iceConnectionState)) {
      current.connected = true;
      setServerStatus("语音已连接", "online");
    }
    if (["failed", "disconnected"].includes(pc.iceConnectionState)) {
      current.connected = false;
      setServerStatus("语音连接受阻", "warn");
      connectionHint.textContent = "语音中继连接受阻，正在等待浏览器重新协商。";
    }
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

async function flushPendingIce(peerId) {
  const record = peers.get(peerId);
  const pc = record?.pc;
  if (!pc?.remoteDescription?.type || !record.pendingIce?.length) return;

  const candidates = record.pendingIce.splice(0);
  for (const candidate of candidates) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("Queued ICE candidate ignored", error);
    }
  }
}

async function addIceCandidateForPeer(peerId, payload) {
  if (!payload) return;
  const record = peers.get(peerId);
  const pc = record?.pc;
  if (!pc) return;

  const candidate = new RTCIceCandidate(payload);
  if (!pc.remoteDescription?.type) {
    record.pendingIce = record.pendingIce || [];
    record.pendingIce.push(candidate);
    return;
  }

  try {
    await pc.addIceCandidate(candidate);
  } catch (error) {
    console.warn("ICE candidate ignored", error);
  }
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
  await ensureRtcConfigFresh();
  const pc = createPeerConnection(peer.id, false);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal(peer.id, "offer", pc.localDescription);
}

async function handleSignal(message) {
  try {
    const from = message.from;
    if (!from || from === state.clientId) return;

    const record = peers.get(from) || { id: from, name: "队友" };
    peers.set(from, record);
    if (!record.pc) {
      await ensureRtcConfigFresh();
    }
    const pc = createPeerConnection(from, true);

    if (message.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
      await flushPendingIce(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(from, "answer", pc.localDescription);
    }

    if (message.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
      await flushPendingIce(from);
    }

    if (message.type === "ice") {
      await addIceCandidateForPeer(from, message.payload);
    }
  } catch (error) {
    console.warn("Signal handling failed", error);
    setServerStatus("语音协商重试中", "warn");
  }
}

async function poll() {
  while (state.joined && !state.pollAbort) {
    try {
      const res = await fetch(`/api/poll?room=${encodeURIComponent(state.room)}&clientId=${encodeURIComponent(state.clientId)}&after=${state.lastSeq}`);
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          const gone = new Error("Room connection was closed");
          gone.name = "RoomGoneError";
          throw gone;
        }
        throw new Error("Polling failed");
      }
      const data = await res.json();
      for (const message of data.messages) {
        state.lastSeq = Math.max(state.lastSeq, message.seq);
        if (message.type === "peer-joined") {
          upsertPeerRecord(message.peer);
          addChatItem({ kind: "text", text: `${message.peer.name} 加入了房间`, name: "系统", mine: false });
        } else if (message.type === "peer-left") {
          const name = peerName(message.from);
          removePeer(message.from);
          addChatItem({ kind: "text", text: `${name} 离开了房间`, name: "系统", mine: false });
        } else if (message.type === "peer-state") {
          upsertPeerRecord(message.peer);
        } else if (message.type === "chat" || message.type === "emoji") {
          handleRoomEvent(message);
        } else {
          await handleSignal(message);
        }
      }
      setServerStatus("信令在线", "online");
    } catch (error) {
      if (error.name === "RoomGoneError") {
        await leaveRoom("这个账号已在其他窗口进入房间，旧连接已自动关闭。");
        return;
      }
      setServerStatus("正在重连信令", "warn");
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
}

async function joinRoom(event) {
  event.preventDefault();
  if (state.joined) return;
  if (!currentUser) {
    setAuthMessage("请先登录账号", "error");
    setServerStatus("请先登录账号", "warn");
    return;
  }

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
    connectionHint.textContent = "已默认开启按住空格说话，可以大幅减少回音；复制邀请链接发给队友即可。";
    muteBtn.disabled = false;
    deafenBtn.disabled = false;
    leaveBtn.disabled = false;
    chatCollapsed = false;
    unreadChatCount = 0;
    loadChatHistory(data.history || []);
    setChatEnabled(true);
    addChatItem({ kind: "text", text: `${state.name} 进入了房间`, name: "系统", mine: false });

    upsertPeerRecord(localPeer());
    applyMuteState();
    applyOutputVolume();
    renderFriends();
    loadFriends(true);
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

async function leaveRoom(message = "创建房间后，邀请朋友打开链接加入。") {
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
  setChatEnabled(false);
  chatCollapsed = false;
  unreadChatCount = 0;
  chatInput.value = "";
  chatItems = [];
  renderChat();
  setServerStatus("已离开房间", "offline");
  setMicStatus("麦克风未开启", false);
  connectionHint.textContent = message;
  renderFriends();
  loadFriends(true);
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
authForm.addEventListener("submit", submitLogin);
registerBtn.addEventListener("click", submitRegister);
logoutBtn.addEventListener("click", logout);
friendForm.addEventListener("submit", submitFriendRequest);
friendRefreshBtn.addEventListener("click", () => {
  loadFriends();
  loadRoomInvites();
});
friendList.addEventListener("click", handleFriendActionClick);
friendRequestList.addEventListener("click", handleFriendActionClick);
roomInviteList.addEventListener("click", handleFriendActionClick);
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
leaveBtn.addEventListener("click", () => leaveRoom());
outputVolume.addEventListener("input", applyOutputVolume);
pttMode.addEventListener("change", applyMuteState);
noiseToggle.addEventListener("change", applyNoiseConstraints);
chatForm.addEventListener("submit", sendChatMessage);
chatToggle.addEventListener("click", toggleChat);
emojiButtons.forEach((button) => {
  button.addEventListener("click", () => sendEmoji(button.dataset.emoji));
});
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

window.addEventListener("focus", () => {
  if (currentUser) {
    loadFriends(true);
    loadRoomInvites(true);
  }
});

window.addEventListener("beforeunload", () => {
  if (state.joined) {
    navigator.sendBeacon("/api/leave", JSON.stringify({ room: state.room, clientId: state.clientId }));
  }
});

setCurrentUser(null);
setChatEnabled(false);
updateChatChrome();
loadCurrentUser();
refreshInviteBaseUrl();
renderPeers();
renderChat();
renderFriends();
renderRoomInvites();
