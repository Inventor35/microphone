# PartyLink

一个轻量的开黑连麦小应用：Python 提供房间和 WebRTC 信令，浏览器之间优先用 WebRTC 直连传语音，也可以配置 TURN 中继来支持不同网络下的稳定连麦。

内置轻量账号系统：支持注册、登录、退出、添加好友和处理好友请求，密码使用 PBKDF2 哈希保存，登录态通过 HttpOnly Cookie 保存。本地默认使用 SQLite；部署时如果配置 `DATABASE_URL`，会自动改用 PostgreSQL 持久化保存账号和聊天数据。

公屏聊天会为每个房间保存最近 100 条文字和表情消息，新加入房间或刷新后会自动加载这些历史记录。

## 运行

```bash
python3 server.py
```

服务器默认会启用 HTTPS，并在终端里打印本机地址和可分享给同一 Wi-Fi/局域网朋友的地址，例如：

```text
PartyLink running at https://127.0.0.1:8765
Share one of these LAN addresses with friends on the same Wi-Fi/network:
  https://192.168.1.23:8765
```

你自己打开 `https://127.0.0.1:8765`。朋友在电脑浏览器里打开终端打印的 `https://你的局域网IP:8765` 地址。进入房间后，页面里的复制按钮也会优先复制局域网 HTTPS 邀请链接。

第一次打开自签名 HTTPS 地址时，浏览器通常会出现安全提示；选择继续访问后，再允许麦克风权限。输入昵称后直接进入会创建新房间；把页面里的邀请链接发给朋友，朋友打开后会自动加入同一个房间。

如果只想本机调试 HTTP，可以运行：

```bash
PARTYLINK_HTTP=1 python3 server.py
```

## 注意

- 没有配置 TURN 时，不同网络/不同运营商之间可能无法直连语音；同一个 Wi-Fi/局域网通常更容易成功。
- macOS 防火墙如果拦截 Python，需要允许传入连接。
- 大多数浏览器不允许普通 HTTP 站点使用麦克风，所以给朋友用时请使用 `https://` 地址。
- 如果要让远端朋友从互联网加入，建议把这个服务部署到带 HTTPS 的域名后面，并配置 TURN 服务来穿透严格 NAT。
- 当前版本适合小队语音，采用 mesh 连接；人数建议 2 到 5 人。
- 账号数据本地默认保存在 `partylink.db`。如果部署平台的文件系统会重置，账号也会随实例重建而丢失；需要长期保存账号时，推荐设置 `DATABASE_URL` 使用外部 PostgreSQL 数据库，或者把环境变量 `PARTYLINK_DB` 指向持久化磁盘路径。

## 免费持久化数据库

Render 免费 Web Service 的本地文件不能可靠保存账号。想继续用免费 Web Service，可以创建一个外部 PostgreSQL 数据库，然后在 Render 的 Environment 里添加：

```text
DATABASE_URL=你的 PostgreSQL 连接地址
```

保存后重新部署，应用会自动建表，并把新注册账号、好友、公屏最近 100 条消息保存到 PostgreSQL。旧的临时 SQLite 账号一般无法自动迁移；配置好数据库后请重新注册一次账号。

如果 `DATABASE_URL` 连不上，应用会先退回本地 SQLite 启动，避免整个网站部署失败；这时账号不会长期持久化。修好 `DATABASE_URL` 后重新部署即可恢复 PostgreSQL。

本地开发不需要配置 `DATABASE_URL`，直接运行 `python3 server.py` 会继续使用项目目录里的 `partylink.db`。

## TURN 与远程连麦

WebRTC 会先尝试浏览器直连；当你和朋友不在同一个网络、路由器或运营商 NAT 比较严格时，直连可能失败。配置 TURN 后，声音会在直连失败时通过 TURN 中继转发。

很多 TURN 服务会提供一个 REST 接口来动态生成浏览器用的 TURN 凭证。比如 Metered/OpenRelay 注册后可以拿到类似这样的地址：

```text
https://你的app名.metered.live/api/v1/turn/credentials?apiKey=你的API_KEY
```

在 Render 的 Environment 里添加：

```text
PARTYLINK_TURN_REST_URL=上面这条完整地址
```

保存并重新部署后，应用会自动从这个地址获取 `iceServers`。如果你用的是直接给固定用户名和密码的 TURN 服务，也可以改用下面这些变量：

```text
PARTYLINK_TURN_URLS=turn:你的TURN地址:3478,turns:你的TURN地址:5349
PARTYLINK_TURN_USERNAME=你的TURN用户名
PARTYLINK_TURN_CREDENTIAL=你的TURN密码
```

可选变量：

```text
PARTYLINK_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
PARTYLINK_ICE_TRANSPORT_POLICY=all
```

`PARTYLINK_ICE_TRANSPORT_POLICY=all` 会优先直连，失败时再用 TURN；如果你想测试 TURN 是否真的生效，可以临时改成 `relay` 强制所有语音走 TURN。

TURN 用户名和密码必须发给浏览器才能建立 WebRTC 连接，所以生产环境更推荐使用支持临时凭证的 TURN 服务。小范围和朋友使用时，固定凭证也能工作，但要注意流量和费用。

## 回声和噪音

应用默认启用浏览器回声消除、噪声抑制，并在本地做高通/低通滤波、噪声门和动态压缩。为了减少对方听到回声，最好戴耳机；如果用外放，降低监听音量，并让扬声器远离麦克风。

## 正式 HTTPS 网站

局域网 IP 不能直接获得浏览器完全信任的正式证书。要完全去掉“连接不安全”的提示，需要把应用部署到一个有公网域名的 HTTPS 平台，或绑定你自己的域名。

这个项目已经准备好了部署文件：

- `Dockerfile`：给支持 Docker 的平台使用。
- `Procfile`：给 Heroku/Railway 这类 Procfile 平台使用。
- `render.yaml`：给 Render Blueprint 使用，连接 GitHub 后可自动创建 Web Service。
- 生产环境默认用平台 HTTPS 终止 TLS，应用内部用 HTTP，所以部署时需要环境变量 `PARTYLINK_HTTP=1`。

最简单的方式：

1. 把这个项目推到 GitHub。
2. 在 Render 里选择 New Blueprint，连接这个 GitHub 仓库。
3. Render 会读取 `render.yaml` 并创建 Web Service。
4. 部署完成后，平台会给你一个正式 HTTPS 地址，例如 `https://partylink-demo.onrender.com`。
5. 打开这个地址建房，把页面复制出来的邀请链接发给朋友。

Railway、Fly.io 或其他平台也可以部署：选择 Dockerfile 部署，并设置环境变量 `PARTYLINK_HTTP=1`。

如果你有自己的域名，在平台里绑定域名后，平台会自动签发可信 HTTPS 证书；之后朋友打开你的域名就不会再看到证书警告。
