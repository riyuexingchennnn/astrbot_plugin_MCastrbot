# ⛏️ MC × AstrBot

![访问量](https://api.sefinek.net/api/v2/moecounter/@Fairy294-astrbot-plugin-mcastrbot?theme=minecraft)

让 Minecraft 玩家直接和 AstrBot 聊天：公屏消息得到公屏回复，`/tell`、`ask` 得到私聊回复。插件还提供机器人状态面板，以及看向玩家、扫描周围和附近移动等操作。

## 安装

1. 在运行 AstrBot 的机器上安装 **Node.js 18+**。
2. 把本目录放入 AstrBot 的 `data/plugins/`，然后在插件目录运行 `npm ci --omit=dev`。
3. 在 AstrBot WebUI 重载插件，打开插件设置，填写 **服务器地址、端口、机器人名字**；服务器有登录 Mod 时再填 **登录密码**。协议版本可以留空自动识别。

原脚本使用离线模式账号，因此认证方式默认是 `offline`；正版服务器可在设置中选择 `microsoft`。

## 使用

- 玩家在 MC 公屏发言，AstrBot 会在公屏回复；通过 `/tell` 或 `ask` 发给机器人时，会私聊回复。可在插件设置中关闭公屏自动回复。
- 在插件详情页打开 **dashboard**，查看在线状态、玩家、聊天和日志，也可以从面板发送消息或操作机器人。
- 回复太长时，可在插件设置中启用**分段回复**，调整字数阈值、断句规则和发送间隔。
- 如果服务器的 `ask` / `tell` Mod 使用特殊消息格式，可在设置中填写自定义匹配正则。

> 启用插件前请停用原 `fairy-bot` 服务，避免两个客户端使用同一个 MC 玩家名。传送功能需要机器人拥有服务器相应权限。
