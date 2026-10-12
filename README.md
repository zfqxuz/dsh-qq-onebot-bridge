# dsh-qq-onebot-bridge

把 QQ 接进 DeepSeek Harness（下称 DSH）：QQ 消息驱动 DSH agent 会话，agent 的回复自动发回 QQ。给"自己有台机器、有个 QQ 小号、想让 DSH 当机器人脑子"的人用。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org/)
[![dsh](https://img.shields.io/badge/dsh-0.1%20%7C%200.2-6f42c1.svg)](package.json)
[![onebot](https://img.shields.io/badge/OneBot-v11-black.svg)](https://github.com/botuniverse/onebot-11)

[English](README.en.md) · [更新日志](CHANGELOG.md) · [本地改动与已知补丁](LOCAL-PATCH.md) · 当前版本 v0.7.5

## 它解决什么问题

DSH 是本地 agent 运行时，不认识 QQ；NapCat 这类 OneBot 实现能把 QQ 变成 WebSocket 上的 JSON 事件，但不替你管理会话、上下文与权限。本插件补中间那层：**每个群 / 每个私聊一条常驻 DSH 会话**，消息进去、回复出来，顺带处理权限、限流、媒体与群管。

- 一条反向 WebSocket 进、原路出：不需要公网、不需要回调地址，只绑 `127.0.0.1`；会话按群（`sessionMode: chat`）或按人（`user`）分组，宿主重启后可续接同一会话，另有一份持久记忆兜底。
- 默认安全：`allowUsers` / `allowGroups` 为空时**拒绝一切**消息，白名单是唯一入口。默认可排查：每条消息一个 traceId，每次"没回复"都带中文原因；可录制、可离线回放、可注入假事件。它是独立 bundle，不想要了就 `dsh plugin --profile web remove @zfqxuz/dsh-qq-onebot-bridge`。

## 特性

**在 QQ 里聊天与查询**
- 群里 @机器人 说话，或私聊直接说；超长回复自动分段（`maxMessageLength`，默认 1700 字）；别人**合并转发**的聊天记录会展开成正文交给模型（默认上限 50 条 / 4000 字），不再被静默丢弃。
- 只读查询：成员名单与详情、群资料、群荣誉/公告/精华、群文件（可下载到私聊）、群相册、图片 OCR、历史消息。消息按天归档到 `qq-history/`；`/找 关键词` 与 `qq_search_history` 在归档里检索。

**语音与图片**
- 语音转文字：群里 @机器人 引用一条语音、或私聊直接发语音（默认用 DSH 自带的本地识别，音频不出本机）；语音回复与朗读需自备 TTS（本地 GPT-SoVITS 或云端密钥）。
- 看图走识图工具（`visionMode` 可选 `tool` 或原生多模态 `native`）；生图用 `/画 <描述词>`（需自备 OpenAI 兼容接口或本地 SD WebUI）。

**收文件与发文件**
- **收文件默认开**：群里 @机器人 发的文件、私聊直接发的文件都会存到 `qq-files/`，把路径交给模型；小的文本文件（txt/md/json/csv/log/代码）再附 4KB 内容预览，只读访客也看得到。超 `fileTransferMaxBytes`（默认 50 MiB）只回一句不落盘。
- **发文件只给管理员**：`qq_send_file` 按 `qq.write.file` 判权，只有 admin 角色（主人的号 / `adminUsers` 白名单 / 整群升级为 owner 的会话）拿得到；普通群友连这个工具都不会注册。

**群运营、玩法与自动化**（成组开关，默认关，用到再开）
- 群管：`/mute` `/unmute` `/kick`（二次确认）`/clear` `/公告` `/精华` `/名片` `/头衔` `/设管理` `/撤管理` `/邀请策略` `/加群方式` `/退群`。
- 运营：`/群打卡`（QQ 原生群签到）、`/全体余量`、`/禁言名单`、`/批量踢`、`/待办`、`/移动文件`、`/传图`、`/群名`、`/周报` 等。玩法与自动化：签到、积分、运势/抽签/塔罗、骰子、成语接龙、猜数字、投票、群待办、活跃榜、表情回应榜、点赞、戳一戳；定时提醒（含"每天/每周/每个工作日"重复）、定时播报（RSS/天气/MC）、入站 webhook、入群审批、每日日报、掉线自愈。

**可控、可调试、可运维**
- 白名单 + 角色（`owner`/`admin` 与 `guest`）：guest 只读、只能碰自己的目录；写文件与 shell 只给超管。
- 写动作走全局闸门（每分钟 20 / 每天 500）并记审计；另有敏感词过滤、刷屏治理、防撤回、回复限流、消息去重、工作日安静时段。`qq-trace.jsonl` 结构化事件 + 控制台实时事件流与决策链；录制 → 沙箱离线回放（不碰 QQ）→ 事件注入；一键体检、脱敏诊断包、6 条硬约束验收台。
- DSH 设置里多一页「QQ助手」：7 组 59 个开关，每行标出配置键名；点一下原子写入 profile 的 `cordis.patch.yml`（留 `.bak-qqai` 备份），只改本插件那一段。

## 快速开始

前提：Node ≥ 22.13（权限库用内置 `node:sqlite`）、一个能扫码登录的 QQ 小号。先选怎么拿代码，再选跑在哪——**没有 Docker 就走下面 1–5 步（推荐）**，有 Docker 直接看最后的容器一节。

> 不想手动走 1–5 步？**整套（DSH + 插件 + 控制台 + NapCat 指引 + 自启）有一行安装**：
> `curl -fsSL https://raw.githubusercontent.com/zfqxuz/qqbot-deploy/main/host/get-qqbot.sh | bash -s -- --qq <机器人QQ号>`
> （Windows 用 `install.cmd host` 或 [部署包](https://github.com/zfqxuz/qqbot-deploy) 里的 PowerShell 入口；脚本会分层判断，已有 Node/dsh 不会重装）

### 拿代码（三选一）

- **本地目录**：已经有源码目录（自己 clone 的、别人给的、解压出来的包）——直接用。
- **git clone**：`git clone --depth 1 https://github.com/zfqxuz/dsh-qq-onebot-bridge.git`。
- **npm 包**（最省事）：`dsh plugin --profile web install @zfqxuz/dsh-qq-onebot-bridge`（版本以 npm 上的最新发布为准）。

### 一、装 DSH

```sh
npm i -g @deepseek-ai/dsh
dsh --version            # 打印版本号即成功
```

### 二、装插件

```sh
dsh plugin --profile web install @zfqxuz/dsh-qq-onebot-bridge   # 已发布的包，推荐

# 或者从源码目录装（开发 / 自建）：本地目录走 link:，不会替你装运行时依赖 ws
cd <源码目录> && npm install --omit=dev && dsh plugin --profile web install <源码目录>
```

> ⚠️ 只装依赖不等于挂上：还要把**安装时用的名字**写进该 profile `package.json` 的 `dsh.profile.bundles`（npm 装的是 `@zfqxuz/dsh-qq-onebot-bridge`，源码目录 / 软链装的是 `dsh-qq-onebot-bridge`）。省事的两条路：`node control/bin/qq-seed.mjs`（只补缺、不覆盖已有配置，先 `--dry-run` 看），或 DSH 插件页（设置 → 插件 → 安装）——管理器会自己加。

### 三、填白名单并起宿主

编辑 profile 的配置层——**不是**仓库根目录那份 `cordis.patch.yml`（那只是挂载声明）：

```sh
$EDITOR ~/.dsh/profiles/web/cordis.patch.yml
```

```yaml
- id: dsh-qq-onebot-bridge
  config:
    allowUsers: [123456789]    # 你自己的 QQ 号；空数组 = 拒绝所有私聊
    allowGroups: [987654321]   # 机器人要服务的群；空数组 = 拒绝所有群消息
    botQq: 123456789           # 机器人自己的 QQ 号（群内 @ 检测用）
```

```sh
dsh web                  # 默认 http://127.0.0.1:3080
```

验证：日志出现 `QQ bridge ready: reverse-WS ws://127.0.0.1:6700`；`ss -ltn | grep :6700`（Windows：`netstat -ano | findstr :6700`）能看到监听；DSH 设置里出现「QQ助手」页。

### 四、装 NapCat 并接上

- Linux：`curl -fL --connect-timeout 20 --max-time 1800 -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh && bash napcat.sh --docker n --cli y --github-proxy 0`
- Windows：下载 [NapCat.Shell.Windows.OneKey.zip](https://github.com/NapNeko/NapCatQQ/releases/latest)，运行 `NapCatInstaller.exe`，完成后双击 `napcat.bat`
- macOS：[NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest)

然后在 NapCat 的 WebUI（`127.0.0.1:6099`）的 OneBot11 网络配置里加一个**反向 WebSocket 客户端**，地址 `ws://127.0.0.1:6700/`；插件配了 `accessToken` 时这里填同一个 token，最后扫码登录。

验证：控制台「端口 / 进程」里 6700 的连接数 ≥ 1；在群里 @机器人 发 `/help` 能收到使用指南。官方步骤见 [NapCat 文档](https://doc.napneko.icu/guide/boot/Shell)。

### 五、起控制台

```sh
npm run control                    # 或 node control/bin/qq-control.mjs --open
```

默认 `http://127.0.0.1:8799`，启动时打印**带 token 的完整地址**（token 存在被忽略的 `qq-control.json`）。验证：页面顶部能看到控制台 8799、DSH 宿主（端口自动探测）、OneBot 6700、NapCat 6099 的监听状态与占用进程，「会话所有权」卡片显示谁在托管（宿主/容器/桌面端）、名册与容器待机原因，「一键体检」给逐项 pass/fail 与修复建议。另有权限/状态控制台：`npm run acl -- init` 建库后 `npm run acl:ui`（默认 `http://127.0.0.1:8798`，含角色权限矩阵、主体分配、状态页、`/system` 与安装向导）。

### 用 Docker（另一条运行环境）

不想在本机装 Node 与 NapCat：用部署包 **[zfqxuz/qqbot-deploy](https://github.com/zfqxuz/qqbot-deploy)**——`bash install.sh`（Windows 双击 `install.cmd`，macOS 双击 `install.command`）把 `napcat` + `harness`（DSH + 本插件）+ `console` 跑成三个容器，装完打开 `http://127.0.0.1:8798/setup` 走向导（密码 → 白名单 → 系统配置 → 扫码）。更新与卸载见包内 `UPDATE-UNINSTALL.md`。

## 更新与卸载

```sh
dsh plugin --profile web outdated                              # 看有没有新版
dsh plugin --profile web update @zfqxuz/dsh-qq-onebot-bridge   # 更新到这个包的最新版
dsh plugin --profile web remove @zfqxuz/dsh-qq-onebot-bridge   # 卸载
```

- 插件是**独立 bundle**，`remove` 之后就当没装过；它不会动你的会话历史、ACL 库、归档、工作区
  （那些在数据根里，更新与卸载都不碰）。
- 从源码目录装的（`install <源码目录>`）：更新 = `git -C <源码目录> pull && dsh plugin --profile web update`，
  卸载同上（再把当初建的软链删掉）。
- 整套部署（容器/宿主）的更新与卸载见部署包里的 `UPDATE-UNINSTALL.md`（含 `update.sh` /
  `uninstall.sh` / `host/update-host.sh` / `host/uninstall-host.sh`）。

## 配置

配置写在 **profile 的 `cordis.patch.yml`** 中 `id: dsh-qq-onebot-bridge` 的 `config` 块（例：`~/.dsh/profiles/web/cordis.patch.yml`；完整示例见 [examples/cordis.patch.example.yml](examples/cordis.patch.example.yml)）。**密钥只写在这里**（仓库外），仓库根目录那份被 git 跟踪、别往里填。生效方式：重启宿主，或在设置「QQ助手」页点开关（宿主热重载该条目，QQ 桥会短暂重连）。

键名与默认值取自 `lib/index.js` 的 `Config`（schema 是唯一事实源）；示例文件成文较早，个别值（如 `voiceReadingEnabled`）与当前默认不同，以本表与 schema 为准：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` / `port` / `accessToken` | string / number / string | `127.0.0.1` / `6700` / `''` | 反向 WS 监听地址与端口（别把 host 改成 `0.0.0.0`）；OneBot 端须带的 Bearer token（空 = 不校验） |
| `allowUsers` / `allowGroups` | number[] / number[] | `[]` / `[]` | 私聊 / 群白名单；**空 = 拒绝所有私聊 / 群消息** |
| `botQq` / `replyOnlyWhenMentioned` / `mentionAliases` | number / boolean / string[] | `0` / `true` / `[]` | 群内 @ 检测：机器人 QQ 号、仅 @ 才回复、纯文本 @ 的额外称呼 |
| `acceptPrivate` / `sessionMode` | boolean / `chat`\|`user` | `true` / `chat` | 是否响应私聊（仍受 `allowUsers` 限制）；群会话粒度：每群一条 / 每群每人一条 |
| `cwd` / `provider` / `model` | string / string / string | `''` / `''` / `''` | 会话工作目录（空 = 宿主 cwd，运行产物落这里）；覆盖 LLM provider / 模型（空 = agent 默认） |
| `adminUsers` / `adminEnabled` / `identity` | number[] / boolean / object | `[]` / `true` / 未配置 | 管理命令与 admin 身份的来源；管理命令总开关；角色映射：`enabled` / `map` / `defaultRole` / `groupRole` / `groupRoles` / `perSubjectDirs` |
| `aclEnabled` / `aclDbFile` / `permissionPreset` | boolean / string / string | `true` / `''` / `''` | 用 `acl.db` 作角色/权限来源（空路径 = 数据根下 `config/acl.db`）；库不存在时回落到配置翻译；QQ 会话使用的 DSH 权限 preset（空 = 宿主默认） |
| `maxMessageLength` / `botName` | number / string | `1700` / `小鲸鱼` | 单条出站消息最大字符数（超出分段）；机器人显示名（合并转发卡片署名） |
| `actionRatePerMinute` / `actionRatePerDay` / `actionAuditEnabled` | number / number / boolean | `20` / `500` / `true` | 写动作全局闸门（全部会话合计，越限拒绝并记原因）；写操作与拒绝进 `qq-actions.log` |
| `rateLimitEnabled` / `dedupEnabled` / `quietHoursEnabled` / `quietHours` | boolean / boolean / boolean / string[] | `false` / `true` / `false` / `['9:00-12:00','14:00-18:00']` | 出站回复限流（`rateLimitMaxReplies` / `rateLimitWindowSeconds`）；重复 message_id 去重（`dedupWindowSeconds`）；工作日安静时段不回任何消息（提醒与开奖照常）；时段为本地时间 `H:MM-H:MM`，可跨午夜 |
| `memoryEnabled` / `memoryMaxEntries` / `sessionResumeEnabled` | boolean / number / boolean | `true` / `30` / `true` | 每会话持久记忆（`qq-memory/`）与条数上限；宿主重启后续接同一会话 |
| `sessionConflictPolicy` / `sessionConflictWaitSeconds` / `sessionConflictNoticeSeconds` / `sessionConflictMaxQueued` / `sessionConflictBackoffSeconds` / `harnessHeartbeatEnabled` / `harnessHeartbeatSeconds` | enum / number / number / number / number[] / boolean / number | `wait` / `180` / `8` / `5` / `[5,15,60,300,900]` / `true` / `5` | **会话写权被别的客户端占用时**：收下消息 → 排队 → 拿到锁在原会话里按序补跑（`fork` = 超时另开新会话、`fail` = 旧行为），超时与丢弃都会明确回执；**托管权心跳**：每 N 秒在数据根 `state/harness/` 写自己的心跳并选主（宿主与容器共用数据根时，用它判断该不该由本实例起 harness），`/health` 与控制台会显示「谁在托管」 |
| `reminderEnabled` / `reminderMaxPerChat` | boolean / number | `true` / `10` | 定时提醒（群聊需 @；存 `qq-reminders.json`）与每会话上限 |
| `traceEnabled` / `traceLevel` / `traceMemorySize` / `recordInbound` / `inboxRedact` | boolean / enum / number / boolean / boolean | `true` / `debug` / `500` / `true` / `false` | 全链路事件（`warn` 只留问题，省磁盘）；内存里保留的最近事件数；录制每条入站帧到 `qq-inbox.jsonl`（离线回放依赖它）；录制时脱敏 QQ 号 |
| `injectEnabled` / `injectDryRun` / `sttEnabled` / `sttProvider` | boolean / boolean / boolean / enum | `false` / `true` / `false` / `dsh` | 事件注入通道与其 dry-run；**dry-run 保持打开**；语音转文字；`dsh` = 宿主本地识别（不出本机），`cloud` = 走 `sttBaseUrl`+`sttApiKey` |
| `ttsEnabled` / `ttsProvider` / `imageGenEnabled` / `imageGenProvider` | boolean / enum / boolean / enum | `false` / `azure` / `false` / `openai` | 语音回复（**需自备 TTS**）；`local` = 本地 GPT-SoVITS；生图（**需自备后端**）；命令见 `imageGenCommand`（默认 `/画`） |
| `privateImageView` / `groupImageView` / `visionMode` / `memberQueryEnabled` / `groupFileEnabled` / `groupFileDownloadEnabled` | boolean / boolean / enum / boolean / boolean / boolean | `true` / `true` / `tool` / `true` / `true` / `true` | 下载对方发来的图片交给识图工具（存 `qq-images/`）；`native` = 多模态附件直传；`/成员` 与 `qq_member_info`；`/文件` 列表；`/取` 下载（只发私聊）。同类只读项：`albumEnabled`、`ocrEnabled` |
| `fileTransferEnabled` / `fileTransferMaxBytes` | boolean / number | `true` / `52428800` | **收文件默认开**：私聊总是收、群聊被 @ 到时收，存 `qq-files/` 并把路径（小文本文件再附 4KB 预览）交给模型；**发文件（`qq_send_file`）仅管理员**——它按 `qq.write.file` 判权，连 `legacy` 角色也不给 |
| `historyArchiveEnabled` / `historyArchiveKeepDays` / `historySearchEnabled` / `historySearchDays` / `forwardExpandEnabled` | boolean / number / boolean / number / boolean | `true` / `90` / `true` / `7` / `true` | 消息按天归档到 `qq-history/`；过期移入回收站，不物理删除；`/找` 与 `qq_search_history`（默认扫描天数）；展开合并转发（`forwardMaxNodes` 50 / `forwardMaxChars` 4000） |
| `imageRetentionDays` / `imageTrashEnabled` | number / boolean | `14` / `true` | 媒体保留天数；过期**只回收不销毁**（移入 `qq-trash/<日期>/`） |
| `ffmpegPath` | string | `ffmpeg` | 语音转 WAV、GIF 取首帧、大图压缩、本地 TTS 转 mp3 用 |

其余 150+ 个键分两类：**功能开关组**（默认关，用到再开）——`keywordEnabled`、`pointsEnabled`、`gameEnabled`、`antiRecallEnabled`、`filterEnabled`/`filterWordsFile`/`filterAction`、`floodEnabled`、`verifyEnabled`、`statsEnabled`、`checkinEnabled`、`welcomeEnabled`、`dailyReportEnabled`、`broadcastEnabled`/`broadcastJobs`、`webhookEnabled`/`webhookPort`/`webhookSources`、`engageEnabled` 及其子开关、`groupOpsEnabled` 及其子开关、`autoHealEnabled`、`notifyEnabled`；**落点与布局**——`dataRoot`（数据根，见 `lib/paths.js`）与 `persona`（人设注入，见 [LOCAL-PATCH.md](LOCAL-PATCH.md)），这两个不在 schema 里但代码会读。

## 命令与工具

群聊需要 @机器人（标注"私聊"的除外），并受白名单与角色限制。以下按 `/help` 的实际输出整理。

| 命令 | 作用 | 要求 |
|---|---|---|
| `/help`（`帮助`/`菜单`）、`/new`、`/status`、`/health`、`/summary`、`/reminders`、`/撤回`、`/export` | 使用指南、开新会话、会话状态、运行诊断、总结本会话、查看提醒、撤回上一条、导出对话 | 白名单内；除指南/新会话/状态/诊断外各有开关（默认开） |
| `/找 <关键词>` | 检索本会话最近 N 天归档（空格分词 = 同时包含） | `historySearchEnabled` |
| `/荣誉` `/公告` `/群精华` `/群信息`、`/成员 [@某人]` | 只读群信息、成员名单与详情 | `groupReadEnabled`、`memberQueryEnabled` |
| `/文件 [文件夹]`、`/取 <文件名>`、`/相册`、`/ocr`、`/mc <host[:port]>` | 群文件浏览与下载（只发私聊）、群相册、引用图片识字、MC 服务器状态 | 前四项需 NapCat 专有接口 |
| `签到` / `签到榜`、`今日人品`/`运势`/`抽签`/`塔罗`、`.r 3d6`、`/抽一个 A B C` | 本地打卡、运势、骰子（纯本地，不调模型） | `checkinEnabled`；运势与骰子默认开 |
| `/积分` `/排行榜` `/转账 @某人 数量`、`接龙`/`猜数字`/`不玩了` | 积分经济、群内小游戏 | `pointsEnabled`、`gameEnabled`（默认关） |
| `投票：问题？A xx B xx`、`/vote`、`/vote-end`、`/todo add\|list\|done\|clear`、`记一下：xxx` | 投票、共享待办（存 `qq-todos/`） | `voteEnabled`、`todoEnabled`（默认开） |
| `/统计` `/活跃榜` `/周榜`、`/赞榜`、`/谁赞了 <消息ID>`、`/点赞 [@某人]`、`/戳 @某人` | 发言统计、表情回应统计、资料卡赞、戳一戳 | 各开关默认关；`/戳` 还需管理员 |
| `/日报 [on\|off]`、`/kw add\|del\|list`、`/播报 [测试 <id>]` | 日报、词库、定时任务与 webhook 状态 | 对应开关 + 管理员 |
| `/待审`、`/同意 <序号>`、`/拒绝 <序号>`、`/同意 all` | 入群/加好友审批队列 | `verifyEnabled` + 管理员 |
| `/mute` `/unmute` `/kick` `/clear` `/公告` `/精华` `/名片` `/头衔` `/全员禁言` `/解除全员禁言` | 群管（`/kick` 需群里二次确认） | 管理员 |
| `/设管理` `/撤管理` `/邀请策略` `/加群方式 1–5` `/退群 确认`、`/ws`、`/handoff` `/交接` | 群权限管理、工作区切换、会话交接 | 管理员；`/ws`、`/handoff` 仅超管 |

群运营工具箱（`groupOpsEnabled` 打开后，写操作要求机器人在群里是管理员）：`/群打卡`、`/全体余量`、`/禁言名单`、`/群详细`、`/入群通知`、`/打卡名册`、`/管理员名单`、`/批量踢`（二次确认）、`/待办` `/完成待办` `/取消待办`、`/移动文件` `/重命名文件` `/删文件` `/新建文件夹`、`/传图`、`/群名` `/群备注`、`/群权限`、`/历史可见`、`/申请`、`/周报`——各子命令另有开关（`opsReadEnabled`、`opsKickEnabled`、`opsFileEnabled`…）。

agent 工具（QQ 会话内，按角色权限决定注不注册）：`qq_send_image` / `qq_send_file` / `qq_send_voice`（发本地媒体，受 `agentMediaToolsEnabled`、`fileSendDirs`、`fileSendMaxBytes` 限制）、`qq_recall`（撤回自己最近的消息）、`qq_member_info`、`qq_recent_history`、`qq_search_history`、`qq_react`（贴表情回应，写动作过闸门）、`qq_face_list` / `qq_face_send`（`faceEnabled`）。

## 权限与安全

**两道门，顺序是"白名单 → 角色"。**

- 白名单：`allowUsers` / `allowGroups` 为空即全拒；白名单外的人连唤醒 agent 的机会都没有。角色：`identity`（`map` / `groupRoles` / `defaultRole`）与 `adminUsers` 决定"这个人/这个群是谁"；默认 `guest` 且 fail-closed（认不出的角色名一律按 guest，不会意外提权），`owner` 与 `admin` 是同一个超管身份的历史别名。
- 权限库：`aclEnabled` 默认开，角色、授予、deny、限额都是 `acl.db` 里的数据（`npm run acl -- init` 建库、`import-config` 从配置导入；`aclBootstrap: true` 首启自动播种）。库不存在时回落到从配置翻译，行为与旧版一致。界面是权限控制台（`npm run acl:ui`），命令行是 `npm run acl`。

**guest 能碰到什么（真正的边界）**

- 每个主体一个目录：`<数据根>/subjects/u<QQ>` / `g<群号>`，会话 cwd、受限读工具的根、可发送文件的根都是它——群与群、人与人隔离；**同群成员之间不隔离**（`identity.perSubjectDirs: false` 可关，不建议）。
- 只读工具（`read` / `glob` / `grep`）限制在主体目录 + `<数据根>/subjects/shared`；宿主级工具（`session_read`、`ecs_*`、`n8n_*`、`gh_*`、`bash` 等）按权限点白名单裁剪，没授权就不注册。guest 不能写文件、不能跑 shell、不能发自己目录外的文件（`fileSendDirs` 对 guest 不生效）。
- 超管走 profile 里的完整 preset；`permissionPreset` 可按角色覆盖，但 `identity.roles.*.preset` 默认指向 profile 里必须存在的 `qq-coding` / `qq-readonly`——缺了只记一条 warn，会话退化成"只有宿主级工具"，不会静默给权限。

**出站、审计与敏感信息**

- 写动作（发消息/撤回/群管/上传/转发）合计受 `actionRatePerMinute` 与 `actionRatePerDay` 限制，越限拒绝并记录；`actionAuditEnabled` 默认开，写操作与拒绝都进 `qq-actions.log`；`/kick`、`/批量踢`、`/退群` 需群里二次确认。
- `accessToken`、`sttApiKey`、`ttsApiKey`、`imageGenApiKey`、webhook 的 `token`/`secret` 在 schema 里是 secret：运行快照与诊断包不含密钥原文；控制台「导出诊断包」默认勾选脱敏（QQ 号按位掩码、正文替换为「[已脱敏 N 字]」，附 `REDACTED.json` 说明口径）。
- 记录类产物（`qq-inbox.jsonl` 含消息原文、`qq-trace.jsonl` 含会话键与文本片段、`qq-actions.log`）只写本机，且被 `.gitignore` 的 `qq-*` 规则覆盖——cwd 恰好在仓库里也不会误提交。两个控制台都只绑 `127.0.0.1`、所有接口要 token、带 `Origin` 的跨站请求一律拒绝。

## 兼容性

| 项 | 范围 |
|---|---|
| DSH | peer 范围覆盖 `^0.1.x` 与 `^0.2.0-rc.2`；CLI/web 宿主与官方桌面端是同一运行时，两边都能直接装，不需要 `dsh plugin allow-version` 豁免 |
| 协议 | OneBot v11 反向 WebSocket。NapCat 是主要验证目标（OCR、相册、群文件、群打卡、入群通知走 NapCat 专有接口，换实现会不可用）；LLOneBot / OpenShamrock / Lagrange 等同协议实现理论可用，未逐一验证 |
| Node / ffmpeg | Node ≥ 22.13（`node:sqlite` 不再需要 `--experimental-sqlite`；验证环境 v24.9.0）；ffmpeg 可选但建议装（语音转 16kHz WAV、GIF 取首帧、大图压缩、本地 TTS 转 mp3），不在 PATH 时用 `ffmpegPath` 指定 |
| 端口 | 6700（OneBot 反向 WS）、8799（控制台）、8798（权限控制台，同时也是入站 webhook 的默认端口，别同时用默认值）、6099（NapCat WebUI）、9880（本地 GPT-SoVITS） |

一台机器只允许一个实例托管 QQ 桥：web 宿主与桌面端抢同一个 6700，只有一个绑得上，另一个每 15 秒重试并在端口释放后自动接管。也别给两个 profile 配不同端口想"都跑"——它们共用同一份数据目录，会互相覆盖状态。

## 常见问题

**1. 机器人在线，却一句话都不回。** 先确认不是"故意不回"：白名单为空（默认全拒）、群聊没 @机器人、客户端把 @ 发成纯文本而 `mentionAliases` 没覆盖、`quietHoursEnabled` 生效中。发 `/health` 看运行时状态，或打开控制台「实时事件流」筛"仅被拒/失败"——每条都带中文 reason（例如 `mention: 群聊未 @ 机器人`）。

**2. 日志报 6700 被占（EADDRINUSE）。** 这不是崩溃：同机另一个实例（CLI 宿主 / 桌面端）正在托管 QQ 桥，本实例如实报错并每 15 秒重试，占用者退出后自动接管。想固定由某一个托管，就**只在一个 profile 里启用本插件**，不要去改端口。

**3. NapCat 连不上 / 二维码在哪。** 反向 WS 地址是 `ws://127.0.0.1:6700/`（不是 6099）；配了 `accessToken` 时两端必须一致。二维码在 NapCat WebUI（6099）；控制台「扫码状态」优先读本机 NapCat 的 `cache/qrcode.png`（官方原生安装器布局），容器部署才用 `docker cp`；设置「QQ助手」面板顶部也有「QQ助手账号（登录 / 扫码）」直达入口。

**4. 控制台起不来。** 8799 被占时它直接报"端口已被占用"并以退出码 2 退出：`node control/bin/qq-control.mjs --port 8800`。另外 `webhookPort` 默认也是 8798，与权限控制台默认端口相同，两个都要用就改掉其中一个。

**5. 命令被判"没权限"，或机器人只能只读。** 默认角色是 guest：只读、只能访问自己的目录，写文件与 shell 只给 `owner`/`admin`（在 `identity.map`、`identity.groupRoles` 或 `adminUsers` 里配）。`aclEnabled` 打开时以 `acl.db` 为准，用权限控制台查"他到底有什么"，不要靠猜配置。

**6. 语音转文字、TTS、生图分别要准备什么？** 转写默认走 DSH 自带的本地识别（`sttProvider: dsh`）：需要在 profile 里启用实验性的「语音输入」bundle，首次使用会下载模型；也可改成 `cloud` 配自家端点。TTS 与生图 **DSH 与本插件都不自带**，要用就自备服务或密钥；没准备好时功能关着，失败原因会写进 trace 而不是静默。

## 开发与测试

测试都是可直接执行的脚本，多数不起宿主、不联网，用临时目录：

```sh
npm test                                   # 默认入口：控制台的 HTTP / 体检 / 端口逻辑
npm run verify                             # 发布前闸门：control-unit + privacy-unit（扫真实 QQ 号 / 密钥）
node test/<name>-unit.mjs                  # 单测按主题分文件：commands-unit / trace-unit / inbox-unit / acl-unit …
npm run test:acl                           # 权限模型相关的一串（acl / store / console / gates / enforcement / corpus）
node test/replay-live.mjs                  # 真实桥代码 + 真实 OneBot 服务端，沙箱 + dry-run，不需要宿主
node test/live-e2e.mjs                     # 真机：需要宿主在跑（自己扮演 OneBot 客户端连 6700）
node test/live-stream.mjs                  # 真机：控制台的实时事件流 / 决策链 / 体检接口
node test/replay-live-host.mjs --token <控制台 token>   # 录制 → 离线回放 → 注入
```

`test/*-unit.mjs` 是纯逻辑与临时目录，`test/sim-*.mjs` 是老的协议模拟脚本（手工排查用，需宿主运行）。`test/static-unit.mjs` 守静态约束（裸名 import、peer 版本线等），`test/privacy-unit.mjs` 扫描被跟踪文件里不许出现的真实 QQ 号与密钥——改完代码至少跑这两个加相关主题的单测。

## 风险与合规

- 本插件通过**第三方协议实现**（NapCat 等）接入 QQ，不是腾讯官方接口，与《QQ 软件许可及服务协议》相悖；账号存在被限制登录、冻结甚至永久封禁的风险，同设备/同 IP 的其他账号也可能被波及。**请用机器人小号，不要用主号。**
- agent 生成的一切内容都以机器人账号发出，发布者承担全部责任；只用于个人学习与小范围自用，不要做批量营销、广告、骚扰或群控。
- 插件只监听 `127.0.0.1`；不要为了让外网访问而改成 `0.0.0.0`——暴露的是你的机器人账号。语音转写切到云端（`sttProvider: cloud`）会把音频上传第三方，敏感语音不要发；生图与 TTS 同理。
- 使用第三方协议**风险自负**，本项目不提供任何免封号承诺。完整声明见 [LICENSE](LICENSE)。

## 来源与致谢

本项目**衍生自** [cheesehaqi/dsh-qq-onebot-bridge](https://github.com/cheesehaqi/dsh-qq-onebot-bridge)（上游基线 v0.6.3），在其之上继续开发：独立控制台与权限模型（ACL / SQLite）、角色与会话所有权、主体目录隔离、数据根布局、容器部署等；逐项改动见 [CHANGELOG.md](CHANGELOG.md) 与 [LOCAL-PATCH.md](LOCAL-PATCH.md)。采用 MIT 许可（见 [LICENSE](LICENSE)，版权声明为 `dsh-qq-onebot-bridge contributors`），上游原始版权与许可声明一并保留。依赖与致谢：[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（插件宿主与 agent 运行时）、[NapCat](https://github.com/NapNeko/NapCatQQ)（QQ 协议端，主要验证目标）、[OneBot v11](https://github.com/botuniverse/onebot-11)（协议规范）。


## 相关链接

- [CHANGELOG.md](CHANGELOG.md) — 逐版本记录与缺陷清单（当前 v0.7.5）；[LOCAL-PATCH.md](LOCAL-PATCH.md) — 本地改动、人设 / 身份 / 工作区说明
- [examples/cordis.patch.example.yml](examples/cordis.patch.example.yml) — 完整配置示例
- [NapCat 文档](https://doc.napneko.icu/) · [OneBot v11 规范](https://github.com/botuniverse/onebot-11); 部署包 [zfqxuz/qqbot-deploy](https://github.com/zfqxuz/qqbot-deploy)（Docker / 宿主一行装；含 `HOST-INSTALL.md`、`UPDATE-UNINSTALL.md`）
