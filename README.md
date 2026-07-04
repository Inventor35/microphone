# PartyLink

一个零依赖的开黑连麦小应用：Python 标准库提供房间和 WebRTC 信令，浏览器之间用 WebRTC 直连传语音。

内置轻量账号系统：支持注册、登录、退出、添加好友和处理好友请求，密码使用 PBKDF2 哈希保存，登录态通过 HttpOnly Cookie 保存。

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

- 朋友必须和你在同一个 Wi-Fi/局域网，或者你需要做端口转发/公网部署。
- macOS 防火墙如果拦截 Python，需要允许传入连接。
- 大多数浏览器不允许普通 HTTP 站点使用麦克风，所以给朋友用时请使用 `https://` 地址。
- 如果要让远端朋友从互联网加入，建议把这个服务部署到带 HTTPS 的域名后面。公网连麦也可能需要 TURN 服务来穿透严格 NAT。
- 当前版本适合小队语音，采用 mesh 连接；人数建议 2 到 5 人。
- 账号数据默认保存在 `partylink.db`。如果部署平台的文件系统会重置，账号也会随实例重建而丢失；需要长期保存账号时，把环境变量 `PARTYLINK_DB` 指向持久化磁盘路径。

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
