<p align="center">
  <img src="logo.png" alt="MC × AstrBot 插件图标" width="200" />
</p>

# ⛏️ MC × AstrBot

![访问量](https://api.sefinek.net/api/v2/moecounter/@riyuexingchennnn-astrbot-plugin-mcastrbot?theme=minecraft)

让 Minecraft 玩家直接和 AstrBot 聊天：公屏消息得到公屏回复，`/tell` 消息得到私聊回复。可设置唤醒词来限制触发范围。插件还提供机器人状态面板，以及看向玩家、扫描周围和附近移动等操作。

## 安装

1. 在运行 AstrBot 的机器上安装 **Node.js 18+**。
2. 把本目录放入 AstrBot 的 `data/plugins/`。插件启动时会在缺少 Node 依赖的情况下自动在插件目录运行 `npm ci --omit=dev`；如果服务器无法访问 npm，请在该目录手动执行这条命令后重载插件。
3. 在 AstrBot WebUI 重载插件，打开插件设置，填写 **服务器地址、端口、机器人名字**；服务器有登录 Mod 时再填 **登录密码**。协议版本可以留空自动识别。

原脚本使用离线模式账号，因此认证方式默认是 `offline`；正版服务器可在设置中选择 `microsoft`。

非 online 模式服务器推荐安装 [Login System Mod](https://modrinth.com/mod/loginmod)，为玩家和机器人提供注册、登录保护。在插件设置中填写“登录 Mod 密码”后，机器人会尝试 `/login`，检测到未注册时会尝试 `/register`；请选择与服务器版本及模组加载器匹配的 Mod 版本。

## 使用

- 唤醒词列表默认留空，回复所有 MC 公屏和 `/tell` 消息；填写后，仅当正文包含唤醒词时回复（忽略大小写）。公屏回复走公屏，私聊回复走 `/msg`；可单独关闭公屏回复。已有配置中的唤醒词会保留。
- 在插件详情页打开 **dashboard**，查看连接状态、游戏状态、在线玩家、聊天和运行日志。
- 回复太长时，可在插件设置中启用**LLM 分段回复**，在下方“LLM 分段参数”分组中调整字数阈值、断句规则和发送间隔。旧版分段设置会自动迁入分组。
