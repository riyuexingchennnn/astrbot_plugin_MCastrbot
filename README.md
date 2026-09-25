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

### 对话与提示词

玩家用 `/tell` 向机器人发消息时，回复会通过 `/msg` 私聊发送。公屏自动回复默认关闭；开启“允许回复 MC 公屏消息”后，公屏消息才会进入对话，回复也会发到公屏。唤醒词列表留空表示不设关键词；填写后，只有正文包含唤醒词的消息才会触发回复，匹配时忽略大小写。已有配置中的开关和唤醒词会保留。

“MC Bot 全局提示词”只用于 Minecraft 会话，留空则不追加内容。回复较长时，可以在“LLM 分段参数”中调整分段阈值、断句规则和发送间隔；旧版分段设置会自动迁入该分组。

### 机器人行为

- `idle`：停止自主跟随和战斗，等待自然语言指令。
- `follow`：跟随指定玩家，不主动战斗。
- `auto`：跟随指定玩家，攻击 8 格内的敌对生物；饱食度低于 17 时，按下面的顺序从背包选择食物。自动战斗的目标规则不会因 LLM 指定攻击而改变。

自动进食从左到右、从上到下查找背包，选中第一个已有的食物。会传送或可能造成负面效果的食物不会被自动选中，金苹果等稀有食物也留给手动使用；管理员仍可通过进食工具指定它们。

```text
golden_carrot → cooked_beef → cooked_porkchop → cooked_mutton
cooked_chicken → cooked_rabbit → cooked_salmon → cooked_cod
baked_potato → bread → rabbit_stew → mushroom_stew → beetroot_soup
pumpkin_pie → apple → carrot → beetroot → potato → melon_slice
sweet_berries → glow_berries → cookie → dried_kelp → honey_bottle
beef → porkchop → mutton → rabbit → cod → salmon → tropical_fish
```

跟随目标超出 16 格或实体不可见时，机器人最多每 15 秒请求一次 `/tp` 追上目标。`auto` 和 `follow` 会请求切换到 `survival`。这些行为需要服务器授予机器人相应的 `/gamemode`、`/tp` 和方块、容器交互权限。“登录后游戏模式”可选择 `survival`、`creative`、`adventure` 或 `spectator`。

### 管理员 Agent 工具

先在插件设置中开启“允许 LLM 控制机器人行为”和“允许管理员让机器人调用 Agent 工具”，再把玩家名加入“管理员玩家名列表”。只有满足这些条件的 Minecraft 会话才能调用游戏操作工具。

- `mc_behavior_status` / `mc_stats` 查看机器人状态，`mc_modes` 查看当前行为模式和游戏模式，`mc_entities` 列出附近实体及 ID。`mc_attack_entity` 可按 ID 攻击生物或玩家，`mc_attack_player` 可按玩家名攻击；指定攻击最多持续 30 秒，之后恢复原有行为。`mc_follow_player` 让机器人跟随指定玩家，`mc_set_mode` 可在待机、跟随和自动战斗间切换。自动战斗的怪物列表不会被指定攻击改变。
- `mc_send_public` 让机器人在公屏发言；内容以 `/` 开头时会执行任意 Minecraft 命令，例如 `/gamemode creative`。服务器仍需授予机器人对应命令的权限。这个工具不受公屏自动回复开关影响，发言后不会在同一公屏会话重复回复相同内容。
- `mc_inventory` 查询背包，`mc_eat` 留空时按食物优先顺序进食，也可指定任意背包物品尝试食用或饮用；`mc_equip_item` 装备物品，`mc_discard` 丢弃物品。`mc_give_player` 会走近玩家并把物品丢在玩家附近，玩家需自行拾取。
- `mc_view_chest`、`mc_take_from_chest`、`mc_put_in_chest` 分别查看、取出、放入附近箱子或木桶中的指定物品。`mc_fetch_supplies` 按食物优先顺序领食物，并领取最好的剑、斧和镐；`mc_store_inventory` 存入背包物品。
- `mc_nearby_blocks` 查找指定方块坐标，`mc_craftable` 检查指定物品及数量能否合成，`mc_craft_recipe` 合成物品，`mc_collect_blocks` 收集方块。`mc_smelt_item` 使用附近熔炉并等待产物，单次最多 8 个；`mc_clear_furnace` 取出熔炉内的产物、原料和燃料。
- `mc_place_here` 在 4.5 格内指定空气坐标放置背包方块，目标旁需有可依附方块。`mc_use_on_entity` 和 `mc_use_on_block` 可对附近实体或方块使用手中或指定的背包物品。
- `mc_go_to_bed` / `mc_sleep` 在附近床上睡觉。`mc_scan_surroundings`、`mc_move_nearby`、`mc_set_auto_combat` 分别扫描、移动和开关自动战斗。`mc_observe_player` 只让机器人看向玩家，不会移动或攻击；插件的 Web API 也提供这项操作。

### 状态面板

在插件详情页打开 **dashboard**，查看连接状态、游戏状态、在线玩家、聊天记录和运行日志。

## CI 与发布

推送分支或提交 PR 时，GitHub Actions 会运行 Node 和 Python 测试。推送 `v1.2.3` 这类 tag 后，测试通过才会创建同名 Release，并附上可安装的 `source.zip`。压缩包内的 `metadata.yaml`、`package.json` 和 `package-lock.json` 版本会同步为 `1.2.3`；预发布 tag 如 `v1.2.3-rc.1` 会创建预发布版本。

安装时请下载 Release 附件 **source.zip**，而不是 GitHub 自动生成的 “Source code” 压缩包；自动生成的源码压缩包保留 tag 提交时的版本字段。
