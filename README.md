<p align="center">
  <img src="logo.png" alt="MC × AstrBot 插件图标" width="200" />
</p>

# ⛏️ MC × AstrBot

![访问量](https://api.sefinek.net/api/v2/moecounter/@riyuexingchennnn-astrbot-plugin-mcastrbot?theme=minecraft)

这个插件让 Minecraft 机器人接入 AstrBot。玩家可以在游戏里和机器人对话；管理员还能让 LLM 控制机器人发言、执行命令、攻击指定实体或完成游戏任务。机器人也可以自主跟随和战斗，连接与游戏状态可在面板查看。

## 功能

- **游戏内对话**：支持 `/tell` 私聊和可选的公屏自动回复；可设置唤醒词、MC 专用全局提示词和长回复分段。
- **自主行为**：机器人可待机、跟随玩家，或在跟随时自动攻击附近的敌对生物并按优先顺序吃背包中的食物。
- **管理员 Agent 工具**：通过自然语言让机器人观察、扫描、移动、攻击指定生物或玩家、查看和使用背包及容器，以及在公屏发言或执行 Minecraft 命令。
- **状态面板**：查看连接状态、在线玩家、机器人位置与游戏状态、聊天记录和运行日志。

## 安装

1. 在运行 AstrBot 的机器上安装 **Node.js 18+**。
2. 把本目录放入 AstrBot 的 `data/plugins/`。插件启动时会在缺少 Node 依赖的情况下自动在插件目录运行 `npm ci --omit=dev`；如果服务器无法访问 npm，请在该目录手动执行这条命令后重载插件。
3. 在 AstrBot WebUI 重载插件，打开插件设置，填写 **服务器地址、端口、机器人名字**；服务器有登录 Mod 时再填 **登录密码**。协议版本可以留空自动识别。

原脚本使用离线模式账号，因此认证方式默认是 `offline`；正版服务器可在设置中选择 `microsoft`。

非 online 模式服务器推荐安装 [Login System Mod](https://modrinth.com/mod/loginmod)，为玩家和机器人提供注册、登录保护。在插件设置中填写“登录 Mod 密码”后，机器人会尝试 `/login`，检测到未注册时会尝试 `/register`；请选择与服务器版本及模组加载器匹配的 Mod 版本。

## 使用

进入游戏后，用 `/tell` 给机器人发自然语言指令，机器人会通过私聊回复。把下面的 `Fairy` 换成你设置的机器人名称：

```text
/tell Fairy 你好，介绍一下你自己
/tell Fairy 给我挖些木头，做个木镐
/tell Fairy 看看附近有没有箱子，里面有什么
/tell Fairy 跟着我走
/tell Fairy 切换成生存模式
```

需要让机器人执行游戏操作时，把玩家名填入“管理员玩家名列表”，开启“允许 LLM 控制机器人行为”和“允许管理员让机器人调用 Agent 工具”；服务器也要授予机器人相应的游戏权限。机器人执行采集、合成等任务时会请求生存模式，任务结束后会保持当前游戏模式。`idle`、`follow` 和 `auto` 分别表示待机、跟随和跟随时自动战斗。

公屏自动回复默认关闭。开启“允许回复 MC 公屏消息”后，玩家可以直接在公屏与机器人对话；可用唤醒词限制触发。私聊不受这个开关影响。“MC Bot 全局提示词”只用于 Minecraft 会话，留空即可不追加提示词。

插件详情页的 **dashboard** 可查看连接状态、在线玩家、机器人位置、聊天记录和运行日志。

## CI 与发布

推送分支或提交 PR 时，GitHub Actions 会运行 Node 和 Python 测试。推送 `v1.2.3` 这类 tag 后，测试通过才会创建同名 Release，并附上可安装的 `source.zip`。压缩包内的 `metadata.yaml`、`package.json` 和 `package-lock.json` 版本会同步为 `1.2.3`；预发布 tag 如 `v1.2.3-rc.1` 会创建预发布版本。

安装时请下载 Release 附件 **source.zip**，而不是 GitHub 自动生成的 “Source code” 压缩包；自动生成的源码压缩包保留 tag 提交时的版本字段。
