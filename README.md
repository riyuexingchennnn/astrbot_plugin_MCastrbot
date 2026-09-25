<p align="center">
  <img src="logo.png" alt="MC × AstrBot 插件图标" width="200" />
</p>

# ⛏️ MC × AstrBot

![访问量](https://api.sefinek.net/api/v2/moecounter/@riyuexingchennnn-astrbot-plugin-mcastrbot?theme=minecraft)

让 Minecraft 玩家直接和 AstrBot 聊天：`/tell` 消息得到私聊回复，开启公屏自动回复后，公屏消息得到公屏回复。可设置唤醒词来限制触发范围。插件还提供机器人状态面板和受控的 Agent 游戏操作。

## 安装

1. 在运行 AstrBot 的机器上安装 **Node.js 18+**。
2. 把本目录放入 AstrBot 的 `data/plugins/`。插件启动时会在缺少 Node 依赖的情况下自动在插件目录运行 `npm ci --omit=dev`；如果服务器无法访问 npm，请在该目录手动执行这条命令后重载插件。
3. 在 AstrBot WebUI 重载插件，打开插件设置，填写 **服务器地址、端口、机器人名字**；服务器有登录 Mod 时再填 **登录密码**。协议版本可以留空自动识别。

原脚本使用离线模式账号，因此认证方式默认是 `offline`；正版服务器可在设置中选择 `microsoft`。

非 online 模式服务器推荐安装 [Login System Mod](https://modrinth.com/mod/loginmod)，为玩家和机器人提供注册、登录保护。在插件设置中填写“登录 Mod 密码”后，机器人会尝试 `/login`，检测到未注册时会尝试 `/register`；请选择与服务器版本及模组加载器匹配的 Mod 版本。

## 使用

- 唤醒词列表默认留空，表示不设关键词；填写后，仅当正文包含唤醒词时回复（忽略大小写）。公屏自动回复默认关闭，开启后公屏回复走公屏；`/tell` 回复走 `/msg`。已有配置中的开关和唤醒词会保留。
- 在插件详情页打开 **dashboard**，查看连接状态、游戏状态、在线玩家、聊天和运行日志。
- 回复太长时，可在插件设置中启用**LLM 分段回复**，在下方“LLM 分段参数”分组中调整字数阈值、断句规则和发送间隔。旧版分段设置会自动迁入分组。
- “登录后游戏模式”下拉列表使用 Minecraft 英文模式名：`survival`、`creative`、`adventure`、`spectator`。切换需要服务器授予机器人 `/gamemode` 权限。
- 在设置中开启“允许 LLM 控制机器人行为”和管理员工具开关，并填写管理员玩家名后，管理员可用自然语言调用 Agent 工具：看向玩家、扫描、附近移动、切换行为模式、跟随、自动战斗开关、收集方块、睡觉、吃面包、存入物品、领取补给和查询状态。
- 行为模式 `idle` 停止自主跟随和战斗，等待自然语言指令；`auto` 跟随指定玩家、攻击 8 格内的敌对生物，并在饱食度低时吃面包；`follow` 仅跟随。跟随目标超出 16 格或实体不可见时，机器人最多每 15 秒请求一次 `/tp` 追上目标。`auto` 和 `follow` 会请求切换到 `survival`；相关行为需要服务器授予机器人 `/gamemode`、`/tp` 和方块、容器交互权限。

## CI 与发布

推送分支或提交 PR 时，GitHub Actions 会运行 Node 和 Python 测试。推送 `v1.2.3` 这类 tag 后，测试通过才会创建同名 Release，并附上可安装的 `source.zip`。压缩包内的 `metadata.yaml`、`package.json` 和 `package-lock.json` 版本会同步为 `1.2.3`；预发布 tag 如 `v1.2.3-rc.1` 会创建预发布版本。

安装时请下载 Release 附件 **source.zip**，而不是 GitHub 自动生成的 “Source code” 压缩包；自动生成的源码压缩包保留 tag 提交时的版本字段。
