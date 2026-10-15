# 官方 QQ 机器人（QQBot v2）通道重构规格

> 分支：`refactor/official-qqbot`
> 状态：P0 草案（只描述，不动行为）
> 日期：2026-10-14
> 目标读者：维护者本人 + 后续接手的人

---

## 0. 关键结论：官方插件可用 —— 但建议「拿它当底座」，而不是「换成它」

腾讯官方（GitHub `tencent-connect` 组织）确实发布了 DSH 插件，且是活跃仓库（MIT，2026-08 建仓，10-13 仍在推）：

| 包 | 版本 | 许可 | 作用 |
| --- | --- | --- | --- |
| `@tencent-connect/dsh-qqbot` | 0.5.2 | MIT | 官方 DSH 通道插件：QQ → DSH agent（含扫码绑定、端内绑定页） |
| `@tencent-connect/qqbot-nodejs` | 1.0.5 | MIT | **协议层 SDK**：token / 网关（WS + Webhook + Ed25519 验签）/ 消息 / 媒体分片上传 / C2C 流式 / 洋葱中间件 |
| `@tencent-connect/qqbot-connector` | 1.2.0 | **UNLICENSED** | 扫码绑定，换取 AppID/AppSecret |

**官方插件开箱能给的**：扫码绑定、私聊/群聊会话隔离（`qqbot:{appId}:{scope}:{peerId}`）、Markdown 输出（代码块/表格感知切分）、图片视觉理解、发本地文件（路径白名单）、`ask_user_question` 内联按钮、审批确认按钮、`/new /compact /model /preset /stop /bot-*`、闲置回收、C2C 流式、access 白名单（`open`/`allowlist`/`disabled`）。

**它没有的（= 我们桥的价值）**：RBAC 权限库与主体隔离、群管/运营命令、玩法（骰子/运势/签到/积分/投票）、归档与检索、定时提醒与播报、入站 webhook、TTS/STT、限流与审计闸门、事件注入与离线回放、控制台与体检。

**结论（三条）**：

1. **想今天止血**：单独起一个 profile 装官方插件、扫码跑通（见 § 14 第 0 步）。它同时验证了主体认证、事件权限、群主开关这些平台侧配置是否正确 —— 这是最便宜的「平台可用性」验证。
2. **想长期保留功能面**：不要把官方插件当替代品，而是把 `@tencent-connect/qqbot-nodejs`（MIT、纯协议层、运行时只依赖 `ws`）作为我们 transport 层的底座。§ 3 里原计划手写的 auth / gateway / 超长重连 / 富媒体上传 / 流式 / 去重 / 限流，全部由它提供，我们只写**事件归一化 + 出站映射 + 能力位**。
3. **同一个 AppID 不要双跑**：两边都连网关会抢事件、双回复。要并存就用两个机器人（两个 AppID，例如官方插件当数字人助手、我们的桥当 TRPG 主持人）。

---

## 1. 为什么做这件事

NapCat 这类第三方 OneBot 实现是**非官方协议**：登录态来自"模拟客户端"，风控一收紧就批量封号。现在账号已经封到不可用，继续在 NapCat 上堆功能等于把能力建在一个随时会塌的地基上。

官方 QQ 机器人（QQ 开放平台 / QQBot v2）是**协议层合规**的通道：不存在封号问题，代价是要接受平台的准入门槛、群主开关、事件权限和消息配额。

结论：**保留 DSH 侧的全部资产**（会话、权限库、审计、控制台、回放），只替换"QQ 接入层"。

---

## 2. 现状盘点（代码事实，不是猜测）

| 文件 | 行数 | 角色 |
| --- | --- | --- |
| `lib/onebot.js` | ~880 | **传输层**：反向 WS server，`EventEmitter`（`message` / `notice` / `request` / `bot-connect` / `bot-disconnect`）+ 65 个 OneBot action 方法 |
| `lib/bridge.js` | ~9360 | 业务主体：路由、会话、权限、工具、玩法、审计、回放 |
| `lib/index.js` | ~420 | 组装：`new OneBotServer(config)` → `new QQBridge(ctx, config, server, logger)` |
| `lib/capabilities.js` | ~170 | 能力注册表（单一事实源，控制台权限矩阵渲染它） |
| `lib/settings-routes.js` / `control/*` | — | 控制台与设置页 |

**关键事实：`QQBridge` 只通过 `this.server` 触碰 QQ**。它调用的方法约 57 个（`sendSegments` / `getGroupMemberList` / `setGroupBan` / `getMsg` / `deleteMsg` / `groupPoke` / `getGroupRootFiles` / `currentSocket` / `on` / `off` …）。

这意味着重构的爆炸半径可以控制在一个目录里：**只要 transport 抽象得干净，`bridge.js` 那 9000 行基本不动。**

---

## 3. 目标架构

```
        ┌──────────────── QQBridge（会话/权限/工具/审计，尽量不动）────────────────┐
        │  归一化事件：message / notice / request → 路由 → agent → 出站动作          │
        └───────────────▲──────────────────────────────────────┬──────────────────┘
                        │ Transport 接口                        │ sendSegments(...)
        ┌───────────────┴───────────────┐        ┌─────────────▼──────────────┐
        │ OneBotServer（现有，保留兼容） │        │ 官方通道 QQBotTransport     │
        │  反向 WS + NapCat             │        │  access_token + Gateway WS │
        └───────────────────────────────┘        │  + OpenAPI + 富媒体上传     │
                                                 └────────────────────────────┘
```

新增目录建议：

```
lib/transport/
  types.js            # 接口定义、归一化事件形状、错误分类（能力缺失/配额/权限/频控）
  onebot-transport.js # 把现有 OneBotServer 包一层（P0 不改行为，纯适配）
  qqbot/
    auth.js           # appId/appSecret → access_token 获取与提前刷新（默认 7200s，提前 5 分钟刷新）
    gateway.js        # /gateway 取 ws 地址 → Identify/Heartbeat/Resume，session_id+seq 持久化
    api.js            # OpenAPI 调用、分页、频控、重试、trace_id 透传
    media.js          # 富媒体上传（URL / 直传 ≤5MB / 分片），本地文件走分片
    events.js         # 官方事件 → 归一化事件
    capabilities.js   # 本通道的能力位（供 lib/capabilities.js 合并）
```

`transport` 配置取值：`onebot`（现状） | `qqbot`（官方，新默认目标） | `both`（迁移期双跑，用于对比回归）。

---

## 4. 官方平台事实速查

> 出处：QQ 机器人官方文档 v2（`/wiki/develop/api-v2/…`），2026-10 抓取。

### 4.1 凭证与鉴权

| 项 | 值 |
| --- | --- |
| 取 token | `POST https://api.bot.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}` |
| 返回 | `{access_token, expires_in}`（`expires_in` 约 7200s；**失败也返回 HTTP 200**，必须判 `code`） |
| 调 API | Base `https://api.bot.qq.com`，Header `Authorization: QQBot {ACCESS_TOKEN}` |
| 错误模型 | 成功直接返回业务数据；失败返回 `{err_code, message, trace_id}`（`err_code` 判错，`message` 只给人看） |

### 4.2 网关（WebSocket，不需要公网）

1. `GET /gateway`（或 `/gateway/bot` 拿建议分片数）→ `wss://api.bot.qq.com/websocket/`
2. 连上先收 `op=10 Hello`（`heartbeat_interval`，实测 45s）
3. 发 `op=2 Identify`：`{token: "QQBot {accessToken}", intents, shard: [0,1], properties}`
4. 心跳 `op=1`，`d` 传**最新收到的 `s`**；回收 `op=11`
5. 断线重连发 `op=6 Resume`：`{token, session_id, seq}` → 平台补发遗漏事件 → `RESUMED`
6. `op=7` 重连、`op=9` 鉴权失败（Invalid Session）

**要持久化 `session_id` + `seq`**（桥重启后能续上而不是丢事件）。

### 4.3 Intents

| 位 | 名称 | 覆盖事件 | 备注 |
| --- | --- | --- | --- |
| `1<<25` | `GROUP_AND_C2C_EVENT` | 群 @ 消息、单聊消息、全量群消息、机器人进退群、好友增删、主动消息开关、入群申请相关 | **主力位** |
| `1<<24` | `GROUP_MEMBER_EVENT` | 群成员加入/退出、入群申请 | 需权限 |
| `1<<26` | `INTERACTION` | 按钮/面板回调 | 需权限 |
| `1<<27` | `MESSAGE_AUDIT` | 消息审核结果 | 需权限 |

> ⚠️ 除频道体系的 `GUILDS` / `PUBLIC_GUILD_MESSAGES` / `GUILD_MEMBERS` 外，**其他 intent 都要在管理端开通**。传了没权限的 intent，网关会**直接断开连接**（不是静默忽略），所以实现里要有"identify 被拒 → 逐步降级 intent 集合 + 控制台点名报错"的自愈逻辑。

### 4.4 消息模型

| 概念 | 事实 |
| --- | --- |
| 出站 `msg_type` | `0` 文本 / `2` Markdown / `6` 输入中（仅单聊）/ `7` 富媒体 |
| 被动消息 | 必须带 `msg_id`；**群 5 分钟内最多回 5 条；单聊 60 分钟内最多回 4 条** |
| 去重 | 同 `msg_id` 可能重复推送；`msg_id + msg_seq` 相同会发送失败（`msg_seq` 从 1 递增） |
| 主动消息 | 不带 `msg_id`。群 1000 条/群/天、20 条/分；单聊 1000 条/用户/天。**群主/用户可在客户端关掉"主动推送"** |
| 互动召回 | `is_wakeup: true`，4 个周期各 1 条 |
| 引用 | 发：`message_reference.message_id`；收：`message_type=103` + `msg_elements` + `message_scene.ext.ref_msg_idx` |
| 撤回 | `DELETE /v2/{groups|users}/{openid}/messages/{message_id}`，**2 分钟内**；机器人为群管理员时可撤普通成员消息 |
| 入站富媒体 | `attachments[]`：`url` / `content_type` / `width` / `height` / `size`；语音额外给 `voice_wav_url` + `asr_refer_text` |
| 消息类型枚举 | `0` 文本 / `3` ARK 卡片 / `101` 并行消息 / `102` 聊天记录 / `103` 引用消息 |
| 全量群消息 | 群主在手机 QQ 给机器人开「接收全量消息」后，推 `GROUP_MESSAGE_CREATE`（不限于 @） |
| 群主三开关 | ① 接收全量消息 ② 主动推送 ③ 撤回成员消息（需先把机器人设为群管理员） |

### 4.5 富媒体（图片 / 语音 / 视频 / 文件）

- 先上传拿 `file_info`，再用 `msg_type=7` + `media.file_info` 发送；`file_info` 有 TTL，过期要重传。
- `file_type`：`1` 图片（png/jpg，软 20MB）、`2` 视频（mp4，软 30MB）、`3` 语音（silk/mp3/wav，软 20MB）、`4` 文件（软 200MB）；硬限制统一 200MB；超软限制降级为文件。
- 上传三选一：**URL 上传**（平台转存，可能失败）/ **直传二进制 ≤5MB** / **分片上传**（`upload_prepare` → 分片 `PUT` → `upload_part_finish` → `files` 合并，推荐）。
- 单聊与群聊的上传结果**不互通**。

### 4.6 群能力（官方现状）

| 能力 | 接口 | 状态 |
| --- | --- | --- |
| 群信息 | `GET /v2/groups/{group_openid}/info` | ✅（群名/简介/分类/标签/人数） |
| 群成员禁言 | `POST /v2/groups/{group_openid}/restrict_chat_setting` | ✅ 机器人需**群管理员**；只能操作普通成员；≤30 天；单次 ≤20 人 |
| 群成员批量移除 | `POST …/batch_remove_members` | 🟠 **内邀中**（未开放） |
| 群成员列表 / 成员详情 | `GET …/members` `/members/{member_openid}` | 🟠 **内邀中** |
| 群黑名单 | `GET/POST …/member_blacklist` | 🟠 **内邀中** |
| 入群申请审批 | `POST …/approval_join_request/{member_openid}` | ✅ 机器人需管理员 |
| 加群策略 CRUD | `/v2/groups/join_approval_strategy*` | ✅ |
| 机器人群内状态 | `GET …/bot_state` | ✅ |
| 群公告 / 精华 / 相册 / 群文件列表 / 历史消息 / 戳一戳 / 点赞 / 群签名 / 群待办 / 头衔 / 群名片 / 全群禁言 / 移动重命名文件 | — | ❌ 官方无对应接口 |

### 4.7 准入门槛（这段决定了"能不能用"）

| 主体状态 | 服务范围 |
| --- | --- |
| 未认证 | 仅管理员自己用；可加进**自己（管理员）是群主**的群 |
| 个人认证 | 可公开使用；进群上限 500 个 |
| 企业认证 | 全部场景开放 |

- 沙箱：**新版管理端已取消**，管理员账号直接在群里/单聊里测。
- IP 白名单：**可选**（不设置 = 允许所有来源）；设了只允许列表内单个 IPv4，最多 50 条。
- 内部体验号码：最多 20 个，不受服务范围限制（用来让群友先体验）。
- Markdown 与消息按钮：**已面向所有机器人开放，无需申请**。

---

## 5. 事件归一化映射

统一产出内部形状（`messageType: 'group' | 'private'`，`groupId` / `userId` 在本通道里就是 openid 字符串）：

| 官方事件 | Intent | 归一化为 | 要点 |
| --- | --- | --- | --- |
| `GROUP_AT_MESSAGE_CREATE` | 1<<25 | `message(group)` | `content` 已去掉 @ 前缀；`author.member_openid` / `member_role` / `mentions[]` |
| `GROUP_MESSAGE_CREATE` | 1<<25 | `message(group)` | 全量模式；`replyOnlyWhenMentioned` 要**自己**用 `mentions[]` 判 |
| `C2C_MESSAGE_CREATE` | 1<<25 | `message(private)` | `author.user_openid`；`message_type=103` 走引用分支 |
| `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT` | 1<<25 | `notice` | 入群欢迎/竞态清理用 |
| `GROUP_MSG_RECEIVE` / `REJECT` | 1<<25 | `notice` | 主动消息开关状态同步 |
| `FRIEND_ADD` / `FRIEND_DEL` / `C2C_MSG_RECEIVE` / `REJECT` | 1<<25 | `notice` | 同上（单聊侧） |
| `GROUP_MEMBER_ADD` / `REMOVE` | 1<<24 | `notice` | 群成员变动 |
| `GROUP_JOIN_REQUEST` | 1<<24 | `request` | 机器人需群管理员 |
| `INTERACTION_CREATE` | 1<<26 | `request` | 按钮回调（面板/键盘） |
| `READY` / `RESUMED` / `op=7` / `op=9` | — | 生命周期 | 写 `session_id`/`seq`，控制台展示连接状态 |

附件映射：`content_type=voice` → 语音（优先 `voice_wav_url`，`asr_refer_text` 作为平台 ASR 参考）；`image/*` → 图片；`video/mp4` → 视频；`file` → 文件。

---

## 6. 出站动作映射与能力矩阵

| 现有能力（OneBot action） | 官方做法 | 状态 |
| --- | --- | --- |
| 发文本 / 分段 | `msg_type=0`，超长拆多条 | 🟡 受"同 `msg_id` 最多 5/4 条"约束，超出转主动消息 |
| Markdown | `msg_type=2` | ✅ 可直接用 |
| 图片 / 语音 / 文件 | `files` 上传 → `msg_type=7` | ✅ 本地文件走分片上传 |
| 引用回复 | `message_reference` | ✅ |
| 输入中状态 | `msg_type=6`（仅单聊） | ✅ 新增能力 |
| 流式输出 | `/v2/users/{user_openid}/stream_messages`（仅单聊） | ✅ 新增能力（群不支持） |
| 撤回自己消息 | `DELETE …/messages/{id}` | 🟡 2 分钟窗口 |
| 撤回他人消息 | 同上（需群管理员） | ✅（需先把机器人设管理员） |
| 单人禁言 / 解除 | `restrict_chat_setting`（`op=add/update/del`） | ✅ 需管理员；≤30 天 |
| 全群禁言 | — | ❌ 能力位关闭 |
| 踢人 | `batch_remove_members` | 🟠 内邀中，先关能力位 |
| 群成员列表 / 成员详情 | `members` | 🟠 内邀中 |
| 群信息 | `info` | ✅ 字段比 OneBot 少 |
| 加群审批 / 加群策略 | 官方对应接口 | ✅ |
| 群文件（列目录/下载/移动/重命名/相册） | — | ❌ |
| 群公告 / 精华 / 头衔 / 名片 / 群签名 / 群待办 / 新成员历史可见性 | — | ❌ |
| 戳一戳 / 点赞 / 表情回应 | — | ❌ |
| 历史消息 / 合并转发展开 | — | 🟠 改用 `message_type=102` 的 `msg_elements` 现场展开；**拉不到更早历史** |
| OCR | — | ❌ 官方无；可继续用 DSH 侧识图工具（`visionMode`） |
| 掉线自愈（拉起 NapCat 进程） | — | ❌ 不需要（网关自带重连/Resume） |

**落地方式**：给 `lib/capabilities.js` 的 `gate` 增加一种 `{ kind: 'transport', feature: 'group.mute' }`，由当前 transport 的能力集求值。这样 ❌ 的命令/工具在官方通道下**自动不注册**，控制台权限矩阵里显示为"本通道不可用"，而不是让用户发出去才发现报错。

---

## 7. 硬约束与降级策略（行为差异清单）

1. **被动/主动窗口**：群 5 分钟/5 条、单聊 60 分钟/4 条。agent 思考 + 工具调用很容易超 5 分钟 ⇒ 超窗的重试必须**显式降级为主动消息**，并记审计（占用配额）。
2. **主动消息配额**：群 1000 条/群/天；且群主可关「主动推送」。⇒ `reminders` / `broadcast` / `feed` / 日报 / 掉线播报 全部要过**配额守门**（本地计数 + 超限降级为"合并成一条摘要"），开关状态来自 `GROUP_MSG_REJECT/RECEIVE` 事件。
3. **消息去重**：同 `msg_id` 可能重复推送 ⇒ 现有去重逻辑保留，键从 `message_id` 换成 `msg_id`。
4. **openid 隔离**：不同 AppID 的 openid 不通用；同一个人在群内（`member_openid`）与单聊（`user_openid`）也是两个 id。⇒ 见第 8 节。
5. **拿不到 QQ 号**：白名单/权限库目前以 QQ 号为键，官方通道只能拿到 openid。跨应用打通需要申请 `union_openid`（邮件申请，1–3 工作日），**不作为 P0 依赖**。
6. **无历史消息接口**：`/找` 只能搜"桥收到并归档过的"消息（现有 `qq-history` 归档继续用），不能回补入群前的历史。
7. **富媒体 TTL**：`file_info` 过期要重传 ⇒ 出站媒体走"每次上传 + 短期缓存（key = 文件哈希）"。
8. **群内回复限次**：同一 `msg_id` 第 6 次回复必然失败 ⇒ 分段器要按"剩余可回次数"预算切分，超了切主动消息或只发最后一段。
9. **消息长度**：现有 `maxMessageLength`（默认 1700）保留；官方文本上限更宽但分段仍按可回次数约束。

---

## 8. 身份模型与 ACL 迁移（最容易踩坑的一块）

现在是 `allowUsers: [QQ号]` / `allowGroups: [群号]` / `identity` 映射。官方通道下：

- 群 → `group_openid`（字符串，32 位十六进制形态）
- 人 → 群内 `member_openid` / 单聊 `user_openid`（两者不同）

**迁移方案**：

1. 配置层保留 `allowUsers` / `allowGroups`，语义改为"本通道的 openid 白名单"（数组元素放宽为字符串）。
2. 新增**主体表**（落在现有 SQLite 权限库）：`subject(openid, channel, kind, label, bound_qq?, role)`，控制台提供"待认领"列表——未知 openid 首次发言时进队列，点一下就能授权/备注（这是官方通道最好的体验路径，因为 openid 没法肉眼识别）。
3. 未认领的 openid 一律**拒绝**（沿用"白名单为空 = 拒绝一切"的安全默认），并在控制台高亮。
4. 群与人的映射同理：机器人被拉进新群 → `GROUP_ADD_ROBOT` → 控制台出现"新群待授权"，而不是直接服务。
5. 若将来申请到 `union_openid`，再加一层"跨应用统一身份"合并（可选）。

---

## 9. 配置增量（草案，先落在 `lib/index.js` 的 `Config`）

```yaml
- id: dsh-qq-onebot-bridge
  config:
    transport: qqbot            # onebot（旧）| qqbot（官方）| both（迁移期）
    qqbot:
      appId: ''                 # 开放平台 AppID
      appSecret: ''             # role('secret')，默认空串
      apiBase: https://api.bot.qq.com
      intents: 33554432         # 1<<25；可叠加 1<<24
      shard: [0, 1]
      gatewayResume: true       # 持久化 session_id/seq 并优先 Resume
      ackOnReady: true          # 控制台显示 READY 机器人在线状态
      aggressiveIntentFallback: true  # identify 被拒时逐步降权重试并点名报错
      uploadMode: chunk         # chunk（分片，默认）| direct（≤5MB）| url
      passiveWindowGroupSec: 300
      passiveWindowPrivateSec: 3600
      activeDailyPerGroup: 1000
      activeDailyPerUser: 1000
    # 旧字段保留：allowUsers/allowGroups 语义改为 openid 字符串数组
```

---

## 10. 控制台与可观测

- 新增「通道」页：transport 切换、AppID/Secret 录入与连通性自检、`access_token` 剩余有效期、网关状态（连接中/READY/RESUMED/心跳延迟）、最近原始事件流（可展开 payload）、intent 开通自检结果、IP 白名单提示。
- 现有 trace / inject / replay 全部保留：注入的事件走**归一化后**的形状，离线回放不依赖任何通道。
- 「待认领主体」列表（第 8 节）。
- 诊断包脱敏规则复用（openid 也要掩码）。

---

## 11. 分阶段计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0** | transport 抽象 + `onebot-transport` 适配；`capabilities` 加 `transport` gate；**行为零变化** | 现有测试全绿；`transport: onebot` 下与今日完全一致 |
| **P1** | 接入官方 SDK 作底座（`new QQBot({ appId, appSecret })`，auth/网关/重连/Resume 交给它）+ 事件归一化 + 群 @ 与单聊文本收发 + 被动回复（`msg_id`/`msg_seq`）+ 长文分段 | 真机：群里 @ 能答、私聊能答、长回复不丢段 |
| **P2** | 富媒体：直接用 SDK 的 `sendImage`/`sendVoice`/`sendFile`（≥5MB 自动分片）+ 引用回复 + 输入中状态 + Markdown；发语音补装可选依赖 `silk-wasm`（mp3 再补 `mpg123-decoder`） | 真机：收图能看图、TTS 语音能播、发文件能下载 |
| **P3** | 身份与运维：主体表 + 控制台待认领、配额守门、撤回、禁言(`restrict_chat_setting`)、能力位裁剪（❌ 命令自动隐藏） | 控制台能授权新群/新人；超配额有降级与审计 |
| **P4** | 迁移：ECS 切通道、NapCat 下线、部署包/安装器/文档更新、README 与 CHANGELOG | 生产跑在官方通道上，NapCat 相关依赖可移除 |

P0 与 P1 之间需要一个"**真机联调**"节点（见第 14 节清单）。

---

## 12. 风险

| 风险 | 应对 |
| --- | --- |
| intent 无权限 → 网关直接断连 | identify 失败降级重试 + 控制台点名；必要时先只用 1<<25 |
| 群里"收不到任何消息"（群主没开开关） | 控制台/`/health` 明确提示"群主需在手机 QQ 打开接收消息/主动推送" |
| 个人主体进群上限 500、未认证只能用自己当群主的群 | 文档写清；必要时走个人认证 |
| 主动消息被用户/群主关闭 | 事件同步开关状态 + 本地降级为被动回复/摘要 |
| 官方接口还在演进（内邀中的接口随时开放/改名） | 能力位 + 接口层薄封装，改一个文件即可 |
| 群内 @ 语义与 OneBot 不同（content 已去前缀、mentions 不含机器人自身） | 归一化层补齐「是否 @ 了机器人」的判定，别让业务层猜 |
| 官方 SDK 默认 intents 不含 `1<<24`（群成员事件）/ `1<<27`（审核） | 需要时用 `new QQBot({ intents })` 自行叠加，并按 § 4.3 做无权限降级 |
| 发语音依赖可选 peer 依赖 `silk-wasm` | 部署包/安装器列为语音功能的可选安装项，缺失时降级为文本 |
| `qqbot-connector` 是 UNLICENSED | 不把它做成公开包的硬依赖；扫码绑定只做本地可选路径，手填 AppID/AppSecret 永远保底 |

---

## 13. 参考

- 官方文档：QQ 机器人 v2（启动接入 / 获取访问凭证 / 事件订阅 Intents / 群聊消息 / 富媒体 / 群聊管理）
- 官方 FAQ：服务范围、群主三开关、沙箱已取消、union_openid 申请
- 官方 DSH 插件：`tencent-connect/dsh-qqbot`（对照其 `src/transport/`：reply-limiter / msgid-cache / chunker / typing-indicator，MIT，实现细节比文档可靠）
- 官方协议 SDK：`tencent-connect/qqbot-nodejs`（`src/protocol/gateway/` 有 opcode / intent / close code 常量；`src/middleware/` 有现成的去重、限流、@ 判定、引用解析、历史缓冲、信封拼装）
- 另一条通道的参考实现：`@tencent-connect/openclaw-qqbot`（官方 OpenClaw 插件）

---

## 14. 开工前需要的东西（Checklist）

**平台侧（你去做）**

- [ ] **第 0 步（可选但强烈建议，约 10 分钟）**：单独建 profile 装官方插件做平台侧验证
      `dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot` 然后 `dsh --profile qqbot`
      扫码绑定 → 把机器人拉进测试群 → 群主开开关 → 群里 @ 一下能回，说明主体认证/事件权限/群开关都通了。
      验证完可以留着当第二个机器人，或卸载；**注意别和我们的桥用同一个 AppID 同跑**。
- [ ] 在 QQ 开放平台建好机器人 → 提供 **AppID + AppSecret**（管理端复制；或扫码绑定后从 profile 配置里取）
- [ ] 管理端「事件订阅」择 **WebSocket**（不需要公网）
- [ ] 确认 `GROUP_AND_C2C_EVENT (1<<25)` 是否已开通；要不要一起开 `GROUP_MEMBER_EVENT (1<<24)`
- [ ] IP 白名单：要么留空（默认允许所有），要么把测试机与 ECS 出口 IP 加进去
- [ ] 目标群：用最新版手机 QQ 把机器人拉进群（未认证主体要求"你的号是群主"）
- [ ] 群主在群里给机器人开：接收消息（全量/@） + 主动推送 + （可选）设为管理员以启用撤回/禁言
- [ ] 决定是否要"接收全量消息"模式（不然群里只有 @ 机器人的消息会推过来）
- [ ] 想好哪些群先切过来（迁移顺序）

**代码侧（我来做）**

- [ ] P0 骨架 + `onebot-transport` 适配（不影响现状）
- [ ] P1 文本通路 + 真机联调
- [ ] P2 富媒体
- [ ] P3 身份/配额/能力位
- [ ] P4 部署切换

**沙箱限制备注**：当前开发沙箱对既有源码目录只有读权限（写目录项返回 EACCES），所以本轮重构在独立克隆里进行，成果通过 `origin` 分支交付；最终合并/部署时需要在有写权限的机器上操作。
