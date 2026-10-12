# 本目录的本地改动记录

## at 段渲染补丁（2026-10-08）
- 文件：`lib/onebot.js`
- 备份：`lib/onebot.js.orig-backup`
- 原因：OneBot 数组格式消息下，桥接只把 `at` 段的 QQ 号存进内部 `ats`（用于判断是否 @ 机器人），
  正文里丢弃该段，导致 agent 看不到"你 @ 了谁"。
- 改动：数组路径与 CQ 字符串路径行为对齐，把 at 渲染进正文：
  - 有昵称：`@昵称(QQ号)`
  - 无昵称：`@QQ号`
- 影响面：仅入站文本渲染；`ats` 的原有语义（判断是否 @ 机器人）保持不变。
- 升级注意：重新下载/更新本仓库会覆盖此改动，需重新打补丁。

## QQ 纯文本输出补丁（2026-10-08，用户要求）
- 文件：`lib/bridge.js`（`#installSession` 里的 `systemPrompt.section`），备份 `lib/bridge.js.orig-backup`
- 原因：用户明确要求「通过 QQ 送达的内容不要用 Markdown」——QQ 客户端不渲染 Markdown，
  直接发 `**加粗**`、`# 标题`、代码块、表格会变成难读的原始符号。
- 改动：在该处注入的系统提示里追加中文要求：对外回复必须纯文本；列举用短横线或 `1. `；
  命令/代码/路径直接贴原文。
- 升级注意：重新下载仓库会覆盖，重打方式同上。

## 全局 Agent 规则（不在本仓库内）
- `~/.dsh/AGENTS.md`：限制 `ecs_*` / `n8n_*` / `gh_*` 工具的主动调用
  （仅当用户明确要求服务器运维/部署/CI 排障时才用）。

## QQ 会话挂载文件读写/bash 工具（2026-10-08，用户要求）
- 新增 preset `qq-coding`（定义在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `# >>> qq-coding-preset >>>` 块）：
  = minimal 的全部插件 + `@deepseek-ai/dsh-tool-fs`（文件读写编辑）+ `@deepseek-ai/dsh-tool-fs-search`（搜索）。
  注意：**不要**再加 `@deepseek-ai/dsh-tool-bash`，它与 minimal 自带的 `@deepseek-ai/dsh-tool-bash-persistent` 都注册 `bash`，会让整个 preset mount 失败。
- 桥接改动：
  - `lib/index.js`：`inject` 追加 `'agentPresets'`
  - `lib/bridge.js` `#createSession`：`meta.agentPreset = 'qq-coding'`，并在 `setup` 里 `await ctx.agentPresets.mount(agentCtx, 'qq-coding')`；
    挂载失败只打警告，不会导致会话创建失败（但该会话将只有宿主级工具）
  - `lib/bridge.js` `#resumeSession`：宿主重启后续接旧 QQ 会话时同样 mount `qq-coding`，否则旧会话只拿到宿主级工具
- 备份：`lib/index.js.orig-backup`、`lib/bridge.js.orig-backup`
- 只影响 QQ 会话；网页会话仍用你的默认 preset（minimal）

## qq-coding mount 失败修复（2026-10-08）
- 现象：QQ 会话 meta 是 `qq-coding`，但实际工具表没有 fs/bash。
- 根因：`qq-coding` preset 同时注册了两个名为 `bash` 的工具：
  `@deepseek-ai/dsh-tool-bash-persistent`（minimal 自带）和 `@deepseek-ai/dsh-tool-bash`（额外追加），
  触发 `tool "bash" is already registered in this scope`，整个 preset 无法 mount。
- 修复：
  1. 从 `~/.dsh/profiles/web/cordis.patch.yml` 的 qq-coding 块中删除 `tool-bash` 行；
  2. `#createSession` / `#resumeSession` 共用 `#mountQqCodingPreset()`，通过
     `ctx.get('agentPresets') ?? ctx.agentPresets` 取注册表，避免某个 DSH 版本不暴露属性时静默跳过；
     成功/失败都会写 `qq-bridge-debug.log` 便于诊断。
- 已存在会话创建时工具集已固化，修复后需重启宿主并续接会话（`#resumeSession` 现在会补 mount）或 `/new`。
- 2026-10-08 验证：启用注入 dry-run，向 `u:<你的QQ号>` 注入消息触发 resume；日志出现
  `mounted preset qq-coding -> {"id":"qq-coding"}`，随后真实请求的工具表从 17 个变为 24 个，
  新增 `bash/read/write/edit/glob/grep/read_image`，agent 本地 `cat qq-sessions.json` 成功。

## QQ 用户 → 角色身份映射（只读访客模式）（2026-10-08，用户要求）

需求：QQ 号映射到角色身份；`<你的QQ号>` → owner（全权限）；其余（含群聊）→ 共用 guest 只读；
guest 不可写、不可执行、不可读 DSH 配置与其他配置文件；guest 对话权限只能只读、不允许申请提权。
设计文档：`SPEC-identity.md`（已评审 v1.1）。

### 改动文件

1. `lib/bridge.js`（新增，未改上游逻辑；原有路径保持不变）
   - `#identityConfig()` / `#roleOf(message)`：按会话解析角色。私聊命中 `identity.map` 用映射角色，
     未命中用 `defaultRole`；**群聊一律 `groupRole`**（默认 guest）。
     `identity.enabled !== true` 时恒为 owner → 一键回退。
   - `#mountQqCodingPreset` 泛化为 `#mountPreset(agentCtx, presetId, where)`。
   - `#createSession` / `#resumeSession`：preset / cwd / permission preset 改由角色决定。
   - `#resumeSession`：**guest 绝不复用旧会话**（旧会话可能带着上一个 preset 的 scoped 工具，
     例如 qq-coding 的 bash；`tools.restrict()` 只能屏蔽宿主级全局工具，屏不掉 scoped 注册），
     直接新建；guest 上下文靠 `qq-memory` 续接。
   - `#installSession` 改为 `async`，新增 `role` 参数与 guest 系统提示段。
   - `#applyGuestRestrictions()`（async）：
     1. `agentCtx.tools.restrict({ allow: [] })` 隐藏全部宿主级全局工具
        （`session_read` / `ecs_*` / `n8n_*` / `gh_*` / `context_handoff` …）；
     2. **惰性 `await import('../../plugins/dsh-tool-fs-jailed/index.js')`** 注册 scoped 的
        `read`/`glob`/`grep`（根目录锁死到 guest 目录）—— 用动态 import 是为了让该模块缺失/损坏时
        只降级为「没有读工具」，而不会让整个桥接插件加载失败；
     3. 自检：`bash`/`write`/`edit`/`read_image`/`session_read`/`ecs_*`… 必须不可见，
        否则在 `qq-bridge-debug.log` 与宿主日志里报 SECURITY LEAK。
   - `#applyRolePermission()`：按角色设置 `permissionPresets`；guest 额外把审批策略设为 `never`
     （有 `approval` 服务时），即需求「不允许申请提权」。
   - `#sendSpec()` / `#sendRoots(role)` / `#resolveSendPath(raw, role)`：guest 的出站文件根目录
     只保留自己的目录（需求 D-2）。

2. `../../plugins/dsh-tool-fs-jailed/`（新增，被桥接按会话注册；**不注册到宿主全局**，
   否则会和 owner 的 `read`/`glob`/`grep` 重名冲突）
   - `index.js`：零第三方依赖的根目录受限读工具，实现 7 条安全约束（规范化边界、绝对路径、
     `..` 逃逸、symlink `realpath` 校验、前缀陷阱、错误信息不回显真实路径、不调用 shell/subprocess）。
   - `test-jail.mjs`：18 项断言，含越界/`..`/symlink/前缀陷阱/`/etc/passwd` 负向用例。

3. `~/.dsh/profiles/web/cordis.patch.yml`
   - `dsh-qq-onebot-bridge.config.identity`：`enabled/map/defaultRole/groupRole/roles`。
   - 新增 preset `qq-readonly`（`order: 10`，**故意只含 persona、不含任何工具插件**）：
     guest 的工具面完全由桥接注入，preset 挂了别的工具也不会泄漏。
   - 第 3 方文件属主/权限：保持 `600`。

4. 目录：`~/qq-users/qqguest`（`0700`），guest 的 cwd 与唯一可读/可发送根。

### 未做（与 spec 的偏差，需知悉）

- `read_image` 未实现：需要 `@deepseek-ai/dsh-attachment` 的 `AttachmentId` brand，
  而本地插件按惯例零第三方依赖。guest 目前无读图能力。
- 未挂载 `dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-bash-sandbox`：
  guest 根本没有 shell 与写工具，「只读」由**能力移除**保证（比沙箱策略更强），
  挂载沙箱栈反而会全局替换 `ctx.shell`、影响所有会话。`approval=never` 仍然按会话设置。
- OS 层 uid 隔离未做（无免密 sudo、无 bwrap、DSH 无 per-session uid），见 spec §7。

### 风险

- guest 目录（`qq-users/qqguest`）与桥接同属 宿主用户，OS 层没有权限边界；隔离完全依赖
  工具面收敛 + `restrict({allow:[]})` + 受限读工具。**若将来给 guest 加任何新工具，必须重新评估。**
- 宿主级工具清单变化（新增危险工具）不会自动被拦：`restrict({allow:[]})` 是白名单式隐藏，
  新工具同样被隐藏，方向是安全的。
- 自检失败会在日志里报 SECURITY LEAK，此时 guest 仍可能拥有危险工具，需要人工介入。

### 验证方式

- 单测：`cd ~/qq/plugins/dsh-tool-fs-jailed && node test-jail.mjs`（18/18）
- 语法：`node --input-type=module --check < lib/bridge.js`
- 运行时：`qq-bridge-debug.log` 搜 `guest` / `tool surface check` / `SECURITY LEAK`

## 联网搜索权限（2026-10-08，用户要求：普通用户和 宿主用户 都能联网搜索）

需求：owner（宿主用户）与 guest（普通用户）都具备 `web_search` / `web_fetch`。

### 改动文件
1. `~/.dsh/profiles/web/cordis.patch.yml`
   - `qq-coding` preset（owner）追加 `@deepseek-ai/dsh-tool-web`，配置 `search: true / fetch: true / searchTimeoutMs: 60000`。
   - `qq-readonly` preset（guest）由「只含 persona」改为「persona + tool-web」。
     注意：guest 的 preset 工具属于**继承工具**，会被 `tools.restrict()` 过滤，所以必须同时改桥接白名单，见下。
2. `lib/bridge.js` `#applyGuestRestrictions()`（备份 `lib/bridge.js.bak-websearch-*`）
   - 原先 `tools.restrict({ allow: [] })` 改为按「当前实际可见」动态生成白名单：
     `['web_search','web_fetch']` 过滤出已注册的项 → `restrict({ allow: webAllow })`。
     preset 挂载失败 / 工具缺失时白名单为空 → 仍然隐藏全部继承工具（fail-closed）。
   - 白名单版 restrict 若抛错，回退 `restrict({ allow: [] })`，不会留下未受限工具面。
   - 桥接按会话注入的 scoped 工具（qq_*、受限 read/glob/grep）不受 restrict 影响，照旧可用。

### 为什么不能只改 preset
DSH 的 `tools.restrict()` 是白名单式遮蔽**继承工具**（global + preset 祖先层），
own-layer 注册（桥接注入的 scoped 工具）不受影响。guest 只加 preset 会被 `allow: []` 一起挡掉，
故白名单必须显式包含联网工具；owner 没有 restrict，直接由 preset 提供。

### 上线与回滚
- 重启：`nohup bash ~/qq/restart-websearch.sh 90 &`
  （延迟重启让当前回合回复先送达；启动失败自动回滚 patch 与 bridge.js）
- 已存在会话工具表已固化：owner 会话靠宿主重启后的 `#resumeSession` 重新 mount preset；
  guest 从不 resume，重启后新建会话即为新工具面。也可用 `/new` 强制新会话。
- 手工回滚：`cp -p ~/.dsh/profiles/web/cordis.patch.yml.bak-websearch-* ~/.dsh/profiles/web/cordis.patch.yml`
  与 `cp -p qq/qq-onebot-bridge/lib/bridge.js.bak-websearch-* qq/qq-onebot-bridge/lib/bridge.js` 后重启。

### 验证
- `node --input-type=module --check < lib/bridge.js`
- `dsh --profile web --dump-config`（exit 0，preset 内出现新的 tool-web 行）
- 重启后 `qq-bridge-debug.log` 搜 `mounted preset qq-coding` / `mounted preset qq-readonly`
  以及 `guest ... restrict({allow:[web_search, web_fetch]}) applied`、`tool surface check passed`。

### 修正（同日，第一版没生效）：guest 改用 own-layer 注入
- 现象：owner 加了 preset 后能用 web_search/web_fetch，guest 群里仍然没有。
- 原因：guest 的 `tools.restrict({ allow: [] })` 会过滤**继承工具**（global + preset 祖先层）。
  第一版把 tool-web 挂在 qq-readonly preset 里，属于继承层，被 restrict 一起挡掉了；
  即使把 web 工具名写进 allow 白名单，也依赖「restrict 时 web 工具已注册进视图」的时序，不可靠。
- 修正：guest 的联网工具改为桥接**直接注册进 agentCtx 自己的 tool layer**（与 qq_*、受限 read/glob/grep 同一机制）：
  `#registerScopedWebTools()` 懒加载上游 @deepseek-ai/dsh-tool-web，调用其导出的
  `applyWebSearchTool(agentCtx, 8, 4, 60000, true)` 与 `applyWebFetchTool(agentCtx, 30000, 200000)`。
  own-layer 注册不受 restrict 影响，也不依赖 preset 工具注册时序。
  - 模块解析：先 `import('@deepseek-ai/dsh-tool-web')`（DSH 运行时解析），
    失败再 `createRequire(process.argv[1]).resolve(...)` 从 dsh 安装目录兜底。
  - qq-readonly preset 恢复为「只含 persona」，不再挂 tool-web。
- 诊断标记：`qq-bridge-debug.log` 中 `[websearch-v2]` 前缀的行。

## 工作区切换（2026-10-08，用户要求：方案 A 完全实现）

需求：在 QQ 对话里选定一个工作区后，之后的对话在「该工作区的最新会话」里继续，
assistant 的输出照常发回当前 QQ 会话；切工作区的权限不能给普通用户。

### 改动文件

- `lib/bridge.js`（新增局部逻辑，原有路径不动；备份 `lib/bridge.js.bak-workspace-20261008-232900`）
  1. 新增模块级 `workspaceProjectKey(cwd)`：与
     `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey()` 逐字符同源，
     把工作区路径编码成 `~/.dsh/sessions/--home-<用户>-xxx--` 的目录名。
     **改了这里必须同步那边**，否则找不到已有会话。
  2. 构造函数新增：`qq-workspaces.json`（JsonStore）、`sessionRootDir`（默认 `~/.dsh/sessions`）、
     `workspaceRegistryFile`（默认 `~/.dsh/storages/workspace.json`）。
     可用环境变量 `QQ_WORKSPACE_SESSION_ROOT` / `QQ_WORKSPACE_REGISTRY` 覆盖（测试用）。
  3. 新命令 `/ws`（别名 `/workspace`、`/工作区`）：
     `/ws` 列工作区（含会话数、最新会话 id、当前绑定）、`/ws <序号或名字>` 切换、`/ws off` 退出。
     工作区名只从 DSH 登记表读，不接受任意路径；5 秒缓存，解析失败当空表。
  4. 权限：`#canSwitchWorkspace()` 用现有身份层判定，**只有 owner** 能切；
     guest（含群聊默认角色）直接回「只对管理员开放」；
     `#openWorkspaceSession()` 里还有一道双保险：guest 即使被写进绑定也拒绝并清掉绑定。
  5. 最新会话判定：`#workspaceSessions()` 扫该工作区 `projectKey` 目录，
     取 `session.*` 文件（不含 `session.lock`）与目录 mtime 的最大值排序；
     登记表 `sessionIds` 只做兜底（跨 projectKey 全根找目录）。
  6. 打开逻辑：`#openSession()` 先看绑定 —— 有绑定就走 `#openWorkspaceSession()`：
     先 `resume` 最新的那条，失败（被占用/已删除）就在该工作区**新建一条**（`meta.cwd = 工作区路径`）；
     绑定期间不写 `qq-sessions.json`，所以 `/ws off` 能回到本聊天原来的会话。
  7. `/new` 在绑定期间只在该工作区里新开一条，不会丢掉本聊天的默认会话记录。
  8. 出站文件根目录：`#sendSpec()` 把已绑定的工作区加入 owner 的可发送目录，
     否则 agent 在工作区里做的文件会被出站校验拒绝。
  9. `/status`、`/help` 增加工作区信息（`/help` 只对 owner 显示这一行）。

### 行为与已知边界

- 切换后 assistant 的普通文本仍由 `assistant/message` 事件走 `#replyTo(entry.route)` 发回本聊天；
  已用 mock 全链路测试覆盖（`test/workspace-unit.mjs`）。
- 会话被桥接 resume 后会一直持有写锁（DSH 的 `session.lock`）：期间网页/TUI 打开这条会话只能读，
  要回网页继续得先 `/ws off`。切换时用 `flock -n` 预探测：目标最新会话已被别的窗口占用，
  就不绑定它，改在该工作区新建一条并明确告知。
- 续接工作区会话时仍按桥接配置的 provider/model（`deepseek-flash`），会重新 mount `qq-coding`
  并注入 QQ 系统提示与 QQ 工具 —— 等于给那条会话「穿 QQ 的衣服」，网页端以后打开会看到这些痕迹。
- 「最新」按文件 mtime，网页端刚打开但还没写入的会话可能排在后面。

### 验证

- 语法：`node --input-type=module --check < lib/bridge.js`
- 新测试：`node test/workspace-unit.mjs`（18/18：列表/权限/最新会话/回复回发/off 回原会话/无会话新建）
- 回归：全部 `test/*-unit.mjs` 通过数与改动前一致（commands/settings/privacy/static/control/find/
  insight/unattended 的既有失败逐项比对无变化）。
  跑测试需要能解析 `@deepseek-ai/*`：临时
  `ln -s <node>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai \
   node_modules/@deepseek-ai`，跑完记得删掉该软链（避免影响宿主解析）。
- 真实数据只读核对：5 个登记工作区都能按 projectKey 找到会话目录与最新会话（runGroup 36 条）。

### 生效方式与回滚

- 代码在宿主重启后生效：`bash ~/qq/restart-dsh.sh`（会中断当前 QQ 会话，随后自动续接）。
- 回滚：`cp -p lib/bridge.js.bak-workspace-20261008-232900 lib/bridge.js` 后重启宿主；
  绑定状态文件可直接删 `qq-workspaces.json`（删了等于全部退出工作区）。

## 群聊看图（2026-10-09，用户要求：群聊里的图片必须能被识别）

现象：群里 @机器人 发图，机器人只拿到一行文件路径，读不出图；群里不 @ 直接发图则完全被忽略。
根因有三层：
1. 群聊图片以前**根本不落盘**，只有「被引用」时才存一份到 `qq-replies/`；
2. 落盘后只把路径写进正文，模型本体没有图像输入；
3. 群聊默认角色是 guest（`qq-readonly`），没有 `read_image`，而旧配置 `visionToolName` 写的
   `describe_image` 在 DSH 里根本不存在（真名 `read_image`）。

### 改动文件

1. `lib/index.js`（备份 `lib/index.js.bak-vision-20261009-021034`）
   - 新增配置 `groupImageView`（默认 `true`）：群聊里被 @ 到时也主动下载图片。
2. `lib/bridge.js`（备份 `lib/bridge.js.bak-vision-20261009-021034`）
   - 新增 `#groupImageAutoView(message)`：`atMe` 或纯文本 @ 命中即算被 @，且 `groupImageView !== false`。
   - 空文本放行条件加上 `groupImageOnly`（否则「@+图、无文字」在早期就被丢弃）。
   - 主动落盘条件从「私聊」扩到「私聊 + 群聊被 @」；native 模式把图作为附件塞进同一轮上下文，
     tool 模式才给路径 + 工具名（并区分 guest —— 没有读图工具就别在提示里承诺）。
   - `#imageBlocksFor()`：把本地图片经 `ctx.get('attachments').saveImages()` 存成 DSH 原生附件块
     `{ type: 'image', attachment }`。
     **关键坑**：`SaveImageAttachment.data` 类型是 `Uint8Array`，这里第一版误传 `buffer.toString('base64')`
     字符串，`saveImages` 必抛错、blocks 恒为空、于是又退回 guest 没有的读图工具。现改为直接传 `Buffer`。
3. `~/.dsh/profiles/web/cordis.patch.yml`
   - `dsh-qq-onebot-bridge.config` 增加：`visionMode: native`、`visionToolName: read_image`、`groupImageView: true`。

### 为什么用 native 而不是给 guest 加 read_image

`read_image` 需要 `@deepseek-ai/dsh-attachment` 的 AttachmentId brand，本地插件按惯例零第三方依赖；
给 guest 开文件工具又会突破只读边界。改用宿主级附件后，图片作为 user 消息的一部分进入上下文，
guest 不需要任何工具也能真正「看见」图（模型 `deepseek-flash` / DeepSeek-V41-Flash 的
`inputModalities` 含 `image`）。

### 生效方式与回滚

- 代码与配置都只在宿主重启后生效：`bash ~/qq/restart-dsh.sh 90`
  （延迟 90s，让当前回合的 QQ 回复先送达；脚本会把自己 setsid 转后台，宿主被杀也不会带走它）。
- 回滚：`cp -p lib/bridge.js.bak-vision-20261009-021034 lib/bridge.js`、
  `cp -p lib/index.js.bak-vision-20261009-021034 lib/index.js`，
  再把 `cordis.patch.yml` 的 `visionMode` 改回 `tool`、删掉 `groupImageView` 后重启。
- 自检：重启后 `qq-bridge-debug.log` 搜 `message image saved`（落盘成功）与
  `native image attach failed`（附件失败）；后者若出现，说明图片没进上下文，需要看具体错误。

## 会话所有权（阶段 2 第一批：启动占位 + 永不 fork）（2026-10-09，用户要求）

### 背景
宿主重启后，"谁先碰到会话谁就是 writer"。网页端（冷会话被打开时会 resume）经常抢先，
而桥接旧逻辑抢不到就**新建一条会话**，于是 QQ 侧的上下文被拆散
（实测 2026-10-09 02:25、02:34 各发生一次；muzu6cn9 -> muzv9i7c -> muzvkzan 都是这么来的）。

### 改动文件
- `lib/index.js`：新增配置项
  `preclaimSessions`(true) / `reconcileSessions`(true) / `claimSessionTransfer`(true)
  / `sessionClaimRetries`(3) / `sessionClaimRetryMs`(1500)
- `lib/bridge.js`（均带 `[本地补丁]` 标记）
  1. `#bindSession(key, sessionId)`：绑定**单一事实源**。绑了工作区写 `qq-workspaces.json`，
     否则写 `qq-sessions.json`。原三处分散写入已全部改为调用它。
  2. `#isWriterHeld(error)`：识别 DSH 的 `SessionAlreadyOwnedError` / `writer-held`。
  3. `#resolveOwnershipConflict(...)`：占用冲突时先按 `sessionClaimRetries` 重试续接；
     仍失败则**明确报错并保留绑定**，把错误抛到消息主路径（catch 会回给 QQ），绝不再新建。
     冲突错误带 `dshSessionConflict=true`，`#openSession` 的工作区分支会照原样向上抛，
     不会被"新建会话"兜底吞掉。
  4. `#preclaimSessions()` + `start()` 里 `void this.#preclaimSessions()`：宿主启动后
     立刻把各聊天绑定的会话抢到自己名下（只续接、绝不新建；guest 跳过；单个失败只 debug）。
  5. `#syntheticMessageForKey(key)`：由 chatKey（`u:<id>` / `g:<id>[:u:<id>]`）造最小 message，
     供启动占位解析 route/role。

### 验证
- `node test/workspace-unit.mjs` 18 passed / 0 failed（绑定重构未回归）
- `node test/session-ownership-unit.mjs` 7 passed / 0 failed（新增）
  - 会话被占用 -> 不新建、给出人话提示、绑定不变
  - 启动占位 -> 续接绑定会话且不新建
- `node test/control-unit.mjs` 159 passed / 4 failed（与 main 完全一致，Windows NapCat 启动器用例在 Linux 上本就不通过）

### 生效方式与回滚
`git merge` 到 main 后重启 dsh web 生效（部署是 symlink）。回滚：切回上一个 commit 并重启。

### 尚未做（阶段 2 第二批）
`context-handoff/requested` 的认领处理（消费者自建接续会话 + 事务化重绑 + 广播 committed + QQ 通知）、
启动对账 `reconcileSessions`（沿 parentSession 跟随 handoff 子会话）、输出可见性埋点。

## 会话迁移契约：桥接认领（阶段 2 第二批，2026-10-09）

### 改动文件
- `lib/bridge.js`（均带 `[本地补丁]` 标记）
  1. `start()` 订阅 `context-handoff/requested`（受 `claimSessionTransfer` 开关控制）。
  2. `#messageFromRoute(route)`：由 route 造最小 message，用于解析角色。
  3. `#findChatForSession(sessionId)`：判断这个会话是不是本桥某个聊天绑定的
     （先查 `this.agents`，再兜底扫 `qq-workspaces.json` / `qq-sessions.json`）。
  4. `#onTransferRequested(payload)`：guest/群聊直接拒绝（D2 不迁移）；否则
     emit `claimed` -> 用桥接自己的 `#createSession` 建接续会话（角色 preset/权限/cwd 都按本聊天重算，
     `#createSession` 内部走 `#bindSession` 完成事务化重绑）-> 把 `digest` 作为 recall 消息注入
     （`#handoff(next, null, ...)`，message 传 null 所以不按注入帧处理，接续回合的回复照常发回 QQ）
     -> emit `committed` -> QQ 里回一句"上下文已交接到新会话"。失败则 emit `aborted`，交回插件决定。

### 验证
- `node test/session-ownership-unit.mjs`：12 passed / 0 failed
  新增 5 项：认领后自建接续会话、绑定事务化切换、广播 claimed+committed、新会话收到 recall 摘要、QQ 收到交接提示
- `node test/workspace-unit.mjs` 18 passed / 0 failed（无回归）

### 尚未做
启动对账 `reconcileSessions`（沿 header.parentSession 跟随 handoff 子会话）、非本桥会话的事件埋点。

## 启动对账 + 事件可见性（阶段 2 第三批，2026-10-09）

### 改动文件（lib/bridge.js，均带 [本地补丁] 标记）
1. `import zlib from 'node:zlib'`（默认导入，Node < 23 没有 zstd 时静默降级，不会 import 失败）。
2. `#readHeaderAt(dir)`：只解会话日志的**首帧**（JSONL+zstd 逐帧拼接，按魔数 28 B5 2F FD 切帧），
   取 header 的 `parentSession` / `agentPreset` 等元信息。
3. `#reconcileSessions()`：扫描 `sessionRootDir` 下所有项目目录（上限 400 个会话目录），
   构建 `parent -> [children]` 映射，从每个聊天已绑定的会话往下走最多 10 层（带环检测，
   同级取 mtime 最新），跟到最新接续会话就 `#bindSession` 重绑。只读、绝不新建。
   guest/群聊跳过（D2）。
4. `#bindingTargets()`：把"聊天 -> 已绑定会话"的收集逻辑抽出来，`#reconcileSessions` 与
   `#preclaimSessions` 共用（去掉重复实现）。
5. `#startSessionMaintenance()`：启动时**先对账、再占位**（顺序重要：对账决定绑到哪条会话，
   占位再去抢它的 writer）。`start()` 里 `void this.#startSessionMaintenance()`。
6. `#onSessionEvent`：非本桥会话（既不在 `this.agents` 也不以 `qq-` 开头）不再完全静默，
   每个 session id 记一次 debug（上限 200 个 id），便于排查"handoff 子会话在跑但输出没人发到 QQ"。

### 验证
- `node test/session-ownership-unit.mjs`：14 passed / 0 failed
  新增 2 项：启动对账跟到 handoff 子会话（真实 zstd 首帧 fixture）、对账不新建会话
- `node test/workspace-unit.mjs`：18 passed / 0 failed

### 已知边界
- 对账只认 `header.parentSession`：桥接旧版"抢不到就新建"产生的历史 fork
  （如 muzu6cn9 -> muzv9i7c -> muzvkzan）没有该字段，连不回来，属预期。

### 修正（同日，T3 实测发现）：注入摘要的 source kind
`#onTransferRequested` 里注入 digest 原用 `source: { kind: 'plugin', plugin: 'context-handoff', form: 'recall' }`，
实测接续会话开局就 `turn/end reason=error: format v4 message requires a producer-owned source kind`
（生产者是桥接，不是 context-handoff 插件）。改成 `source: { kind: 'user' }`（与桥接其它注入一致）。

### 修正（同日，T3 实测发现）：接续会话缺 parentSession
桥接认领后自建的接续会话没有写 `meta.parentSession`，于是：
- 启动对账 `#reconcileSessions` 沿链找不到它（链是断的）；
- 重启后没人能把它和原会话关联起来。
修法：`#createSession(message, key, { cwd, parentSession })` 透传 meta，认领时传 `fromSessionId`。
用例：session-ownership-unit「接续会话带 parentSession（对账链不断）」。

## 可观测性：绑定/占位/对账/认领/冲突进 trace + `/handoff status`（阶段 4 第一批，2026-10-09）

### 背景
阶段 2 的这些路径原来只有 `debugLog` 和 `logger.info`，`qq-trace.jsonl` 里看不到——
出问题时只能蹲文件日志。R11 要求「绑定 / preclaim / 认领 / 迁移 / 冲突进 qq-trace；
`/handoff status` 可见」。

### 改动（lib/bridge.js，均带 [本地补丁] 标记）
1. `#bindSession(key, sessionId, source = 'open')`：绑定是单一事实源，所有收敛路径都经它落
   一条 `stage: 'bind'` trace，带 `source`（`preclaim` / `reconcile` / `reclaim` / `open` …）
   和 `scope`（`workspace` / `chat`）。调用点相应标了来源。
2. `#preclaimSessions`：成功 `stage:'preclaim' ok:true`，失败 `ok:false` 且带
   `writerHeld`（复用 `#isWriterHeld`），能区分"被占用跳过"和"别的错跳过"。
3. `#reconcileSessions`：重绑时 `stage:'reconcile'`，带 `from`/`to`。
4. `#onTransferRequested`：认领 `stage:'transfer'`、完成（带 `digestChars`）、
   广播失败 / 交接失败 `ok:false` 各一条。
5. `#resolveOwnershipConflict`：重试夺回 `stage:'conflict' ok:true`，
   最终拒绝 fork `ok:false` 且 `bindingKept:true` —— 这条是"永不 fork"承诺的审计线索。
6. 新增 `/handoff [status]` 命令（仅管理员）：一屏显示
   工作区 / 绑定会话 / live agent 状态 / 认领迁移·启动占位·启动对账三个开关 /
   最近 6 条生命周期事件（transfer / conflict / preclaim / reconcile / bind，含时间与 ✓✗）。
   非管理员被明确拒绝。

### 验证
- `node test/session-ownership-unit.mjs`：**24 passed / 0 failed**（原 15 项）
  新增：写权冲突 / 启动占位 / 认领迁移 / 启动对账 各自写进 trace；
  `/handoff status` 有回复、显示绑定、显示开关、列出生命周期事件；非管理员被拒。
- `node test/workspace-unit.mjs`：18 passed / 0 failed
- `npm run test:session` 全绿（18 + 24）

### 说明
`mark()`（单条消息的 trace 链）与这些生命周期事件是两条互补的线：
- `mark` 回答"这条消息经历了什么"；
- 新增的 bind/preclaim/reconcile/transfer/conflict 回答"这个聊天的归属是怎么收敛的"。

## 工作区成员登记：QQ 会话必须进 workspace.sessionIds（2026-10-09，用户报障）

### 现象
用户 "/ws dshbot" 绑了工作区，但浏览器的工作区列表里看不到任何 QQ 会话，
哪怕这些会话的 `cwd` 就是 `/home/宿主用户/dshbot`。

### 根因（实测数据）
- 磁盘上 `sessions/--home-宿主用户-dshbot--/` 有 16 条会话（13 条 `qq-*` + 3 条 `session-*`），
  header 里 `cwd` 全是 `/home/宿主用户/dshbot`；
- 但 `~/.dsh/storages/workspace.json` 的 `dshbot` 工作区 `sessionIds` **只有那 3 条 `session-*`**；
- DSH 的工作区列表读的是这份白名单：`WorkspaceEntity.sessionIds` =
  `record.sessionIds.filter(id => sessionPath(id) === workspace.path)`，**不是扫目录**；
- DSH 自己只在 `state.initialized === false` 时跑一次 `WorkspaceRegistry.bootstrap()` 扫盘补齐；
  之后只有走 UI 建会话才会调 `WorkspaceEntity.attachSession()` 追加。
- 桥接是 `ctx.agents.create()` 自己建会话的，从不走 UI → **目录里有、工作区里没有**。

### 修法（lib/bridge.js）
1. `#ensureWorkspaceMembership(binding, sessionId, key, source)`：用 DSH 官方写入口
   `ctx.get('workspaceRegistry').resolveByPath(path).attachSession(id)` 补登记。
   - **不直接改 workspace.json**：那是宿主 `storageDomain` 的东西，绕过写链会和
     `pendingMutation` / 内存快照打架；
   - `attachSession` 自己会校验 `header.cwd` 的 realpath 是否等于工作区路径，不匹配就抛错，
     所以 cwd 不对的会话由 DSH 兜住，桥接不用自己判。
2. `#bindSession()` 里：有工作区绑定就 `void this.#ensureWorkspaceMembership(...)`。
   因为 preclaim / 对账 / 认领交接 / 正常打开**全都收敛到 `#bindSession`**，
   一处挂上就覆盖所有路径（含每次宿主重启的 preclaim）。
3. `#backfillWorkspaceMembership()`：启动回填。对 `qq-workspaces.json` 里出现过的每个工作区路径，
   扫描对应项目目录，把没登记的会话补进去（按 mtime **升序**追加，因为 `attachSession` 是前插，
   这样最终顺序自然是最新在前，与 `#workspaceSessions` 口径一致）。上限 200 条/工作区。
4. `/handoff status` 的最近事件列表加入 `workspace` 阶段。

### 验证
- `node test/session-ownership-unit.mjs`：**27 passed / 0 failed**（原 24）
  新增 3 项：续接的工作区会话被登记、启动回填补上未登记会话、登记写进 trace（stage=workspace）。
- `node test/workspace-unit.mjs`：18 passed / 0 failed。

## 事故复盘 + 修复：取宿主服务的写法把宿主启动打崩（2026-10-09）

### 事故
上线「工作区成员登记」后重启，宿主 `fatal load failure` 起不来：
```
Error: cannot get property "workspaceRegistry" without inject
    at #ensureWorkspaceMembership (lib/bridge.js)
    at #bindSession
    at #preclaimSessions
    at async #startSessionMaintenance
```
必须人工注释掉 `#bindSession` 里那行调用才恢复。**这是我的责任：改动上了启动关键路径，而且没做"取不到服务"的演练。**

### 根因（用 Cordis 本体做隔离实验确认，非猜测）
| 取法（消费者**未声明** inject 时） | 实测结果 |
|---|---|
| `ctx.get(name)` | 返回 `null`/`undefined` —— **它不是"无 inject 读取"入口**，只对已声明 inject 的服务有效 |
| `ctx.reflect.get(name, false)` | ✅ 拿到服务 —— Cordis 文档写的 "Read a service from the store without the inject requirement" |
| `ctx.reflect.get(name, true)` | `null`（strict 只认已激活提供者） |
| `ctx[name]` 属性访问 | ❌ 抛 `cannot get property "..." without inject` |

我写的是 `this.ctx?.get?.(n) ?? this.ctx?.workspaceRegistry` ——
**等于用一个必然抛异常的表达式做兜底**。它抛在 `#preclaimSessions`（启动链）上，
而 `#bindSession` 是同步函数、调用点用了 `void this.#asyncFn()`，
异常变成 unhandled rejection，DSH 视作 fatal load failure → 宿主起不来。

### 修复
1. 新增 `#resolveService(name, ctx = this.ctx)`：三种取法**全部守卫**，任何失败都返回
   `undefined`，**绝不抛**。顺序：`ctx.reflect.get(name,false)` → `ctx[name]`（guarded）。
2. `#ensureWorkspaceMembership` / `#backfillWorkspaceMembership` 改用 `#resolveService`。
3. `#bindSession` 的调用点加双保险：同步 `try/catch` + `.catch(() => {})`。
   登记是**尽力而为**，绝不能影响绑定，更不能带崩启动链。
4. 同类隐患一并修掉：`#applyRolePermission` 里的
   `ctx.get('approval') ?? ctx.approval`（approval 也没在 inject 里，属性回落同样会抛）。
5. `#noteWorkspaceRegistryOnce()`：只记一次诊断，日志里能直接看到"这次到底取到没有"。

### 回归测试（关键：精确复刻事故现场）
`test/session-ownership-unit.mjs` 新增第 9 节：构造一个 ctx，
`ctx.get(name)` 返回 undefined、`ctx.reflect` 不存在、属性访问抛
`cannot get property "workspaceRegistry" without inject` ——
断言桥接**照常启动**、绑定照常工作（消息仍交给 agent）、并把失败记成一条
`stage=workspace ok=false` 的 warn trace。旧代码在这一节会直接崩。

第 8 节也改成按真实 API 形状注入（`reflect.get`），且故意让属性访问抛，
证明代码走的是 `reflect.get` 而不是属性回落。

### 验证
- `node test/session-ownership-unit.mjs`：**31 passed / 0 failed**（原 27，新增 4）
- `node test/workspace-unit.mjs`：18 passed / 0 failed
- Cordis 隔离实验（3 种结构：无 inject / 自身有 inject / 嵌在 group 里）`reflect.get(n,false)` 均命中

### 追加修复：另外三处同样的 `ctx.get()` 误用（用户确认要修）
`#resolveService` 落地后，把剩下所有"取宿主服务"的地方统一过去。它们不会崩（没有属性回落），
但会**静默取不到服务**：

| 位置 | 原来 | 后果 | 现在 |
|---|---|---|---|
| `#registerScopedWebTools` | `agentCtx?.get?.('web') ?? this.ctx?.get?.('web')` | guest 的 `web_search`/`web_fetch` **一直没注册** | `this.#resolveService('web', agentCtx) ?? this.#resolveService('web')` |
| `#imageBlocksFor` | `this.ctx.get('attachments')` | `visionMode: native` 静默退化成"图片存盘 + 读图工具" | `this.#resolveService('attachments')` |
| `#transcribeViaDsh` 调用点 | `this.ctx?.get?.(DSH_SPEECH_SERVICE)` | DSH 本地语音识别服务取不到 | `this.#resolveService(DSH_SPEECH_SERVICE)` |
| `#mountPreset` | `this.ctx?.get?.('agentPresets') ?? this.ctx?.agentPresets` | 侥幸能用（agentPresets 本来就在 inject 里），但注释是错的 | `this.#resolveService('agentPresets')` |

测试：`session-ownership-unit.mjs` 新增第 10 节 —— 注入 mock `web` 服务后，guest 会话
**真的注册出 `web_search` / `web_fetch`**（旧代码这条会失败）。
合计 **33 passed / 0 failed**（session-ownership）+ **18 / 0**（workspace）。

### 追加：工作区查找加回落 + 每一步都留诊断（2026-10-09）
第一次修复上线后，日志确实出现了 `workspaceRegistry resolved via ctx.reflect.get`（服务取到了），
但工作区 `sessionIds` 仍是 3 条、**一条 attach/backfill 日志都没有** —— 说明在某个静默
`return`/`continue` 处分叉了，而当时那几个分支不写日志，排查只能靠猜（很贵）。

改法：
1. `#findWorkspaceEntity(registry, path)`：两条路都试 ——
   `resolveByPath(path)`（官方，内部 realpath 归一化）→ 失败则 `list()` 里按 `path` 精确匹配
   （context-handoff 的 `resolveWorkspace` 也是这么兜的）。两条都失败时把**原因**写进日志。
2. `#noteWorkspaceRegistryOnce` 升级为打印服务形状：
   `resolveByPath=<?> list=<?> keys=[…] listCount=… paths=[…]`，一次重启就能定位。
3. `#ensureWorkspaceMembership` / `#backfillWorkspaceMembership` 的每个提前返回点都带日志
   （registry 不可用 / entity 找不到 / attachSession 缺失 / 项目目录读不到 / 目录为空）。

测试：新增第 11 节 —— registry 只有 `list()`、没有 `resolveByPath` 时，登记依然成功。
合计 **34 passed / 0 failed** + workspace **18 / 0**。

### 追加：为什么"取到了服务"却登记不上 —— 半初始化实例（2026-10-09 第二次）
带诊断重启后拿到决定性一行：
```
workspaceRegistry resolved … list=function … shapeProbeFailed=
  workspace registry order references missing workspace '864902b6-…'（= dshbot 工作区 id）
workspace lookup failed for /home/宿主用户/dshbot:
  resolveByPath=undefined | list threw: (同上)
```
即：`state.workspaceIds` 有 5 条（含 dshbot），但 `entities` 里缺 dshbot → `list()` 抛。

**根因**：`ctx.reflect.get(name, false)` 的语义是"连**未激活**的提供者也返回"
（`_getImpl(name, strict)` 里 `strict && impl.fiber.state !== 2` 才过滤）。
而我的调用点在 **startup 的 preclaim/backfill**，那时 workspaceRegistry 的 fiber 还没激活完：
`state` 已从文件读好、`entities` 还没 `rebuildEntities()`（少最后建的那个工作区）。
所以每次拿到的都是半成品。DSH 自己的 `dsh-api-session-controller` 用的是
`this.ctx.workspaceRegistry` + `static inject = ['workspaceRegistry']` —— 走 inject 才拿到激活实例。

**修法**：
1. `#resolveServiceMode(name, ctx, activeOnly)`：默认**先 strict=true**（只要已激活的），
   只有显式 `activeOnly=false` 才退到 strict=false。属性访问始终守卫。
2. `#resolveWorkspaceRegistry()`：**只认激活实例**；启动期拿不到就返回 undefined。
3. `#backfillWorkspaceMembership()`：拿不到就置 `workspaceBackfillPending = true` 并返回
   （**不再退而求其次用半成品**），等第一次真实会话活动再补。
4. 触发器挂在两个地方：`#ensureSession`（必须！本聊天常被 preclaim 抢占，
   之后消息走"已有 entry 直接返回"分支、不经过 `#bindSession`）与 `#bindSession`。

**测试**（session-ownership 第 12 / 12b 节）：
- 启动期 `strict=true` 返回 undefined、`strict=false` 返回一个 `list()` 会抛的半成品 →
  断言**不崩**且**绝不触碰半成品**（`halfBaked.list` 未被调用）；
- 激活后发一条消息 → 延后的登记被补上；
- 12b：**preclaim 抢先占位**（会话已 live）时，消息也必须触发延后回填。

合计 **38 passed / 0 failed** + workspace **18 / 0**。

### 追加：延后回填的触发器要在"全局会话事件"上，不能在 QQ 入站路径（2026-10-09）
第一次挂的触发器位置错了：挂在 `#ensureSession`（QQ 入站路径）上。
实测证据：重启后用户那条消息进来时日志是 `turn/start turn=14`，**没有** `msg from` /
`session ready` —— 它是**从浏览器**发的（复用同一个 live agent），根本不经过桥接的 QQ 入站路径，
于是"延后回填"永远不触发。本聊天的会话又常被 preclaim 抢先占位，`#bindSession` 那条路也不会走。

修法：触发器挂到 `#onSessionEvent`（`ctx.on('session/event')`，**全局**监听，QQ 与浏览器回合
都会经过）。`#ensureSession` / `#bindSession` 两处保留作为兜底（都是 fire-and-forget，不加延迟）。

测试第 12c 节：启动期挂起后，只发一个**会话事件**（模拟浏览器回合，不经 QQ 路径）→ 断言回填被触发。
合计 **40 passed / 0 failed** + workspace **18 / 0**。

## R12 告警：watchdog 事故流水 + 宿主启动补报到 QQ（阶段 4，2026-10-09）

### 为什么这样做
watchdog 活在宿主**外面**：宿主死了它没法用 OneBot 发消息（通道就在死掉的那个进程里）。
所以它改为把事故**落盘**，宿主一回来再由桥接补报 —— 你不在电脑前也能知道期间掉过线。

### watchdog 侧（ops/scripts/dsh-watchdog.sh）
- 新增事故流水 `qq/logs/dsh-watchdog-incidents.jsonl`，四种事件：
  `down`（首次探到掉线，带原因）/ `restart`（触发重启，带本小时第几次）/
  `recovered`（恢复，带 `downtimeSeconds`）/ `rate-limited`（限流，需要人工介入）。
- 可选 `WATCHDOG_WEBHOOK`：事故时 POST 同一份 JSON（`curl --max-time 8`，失败不影响主流程）。
- 只在**状态跃迁**时记录，不是每次轮询都写（避免 15s 一条刷屏）。

### 桥接侧（lib/bridge.js）
- 新增 `#reportWatchdogIncidents()`：
  - 读事故流水（末 300 行）+ 水位线 `qq/logs/dsh-watchdog-alert-state.json`；
  - 只取 `at > notifiedAt` 的新事件；**先把水位线落盘**（宁可这条丢了，也不要每次启动重复轰炸）；
  - 只有出现 `down`/`restart`/`rate-limited` 才播报（只有 recovered 不打扰）；
  - 发到所有**非 guest 的绑定聊天**（`#bindingTargets()` + `#syntheticMessageForKey`），
    文案含掉线次数 / 自动重启次数 / 最近停机秒数 / 限流警告；
  - 落一条 `stage:'heal'` trace。
- 触发点：`bot-connect`（socket 就绪后）与 `#startSessionMaintenance` 末尾。
  两者都会先检查 socket，没上线就不置水位线，等上线再报。
- 新配置：`watchdogAlertEnabled`（默认 true）/ `watchdogIncidentFile` / `watchdogAlertStateFile`。

### 测试（session-ownership 第 13 节）
- 事故流水（down+restart+recovered/23s）→ 断言 QQ 收到"掉线告警…23 秒后恢复"；
- 水位线已写；**同一批事故再启动一次不重复播报**；增量事故（最新 1s）能补报。
合计 **44 passed / 0 failed** + workspace **18 / 0**。

## 保留期清理：定时化 + 回收站二次清理 + qq-tts 纳入（2026-10-09，用户要求）

### 起因（用户问"QQ 相关消息记录有定时清理吗"）
查完发现三处不对：
1. **不是"定时"**：图片/归档的保留期清理只在 `#startSessionCleanup` 那类启动路径里跑
   （`start()` 里调一次 `#cleanupImageDirs()` + `#pruneArchive()`）——宿主长期不重启 = 不清理；
2. **回收站只进不出**：第一道保留期把过期文件"移入" `qq-trash/<日期>/`（"绝不真删"的安全策略），
   但 `qq-trash/` 本身**没有任何清理**，只增不减；
3. **`qq-tts/` 是漏网的**：`#cleanupImageDirs` 只遍历 `imageDir / quoteDir / filesDir`。

### 改动（lib/bridge.js + lib/index.js）
1. `#cleanupImageDirs()`：遍历加入 `this.ttsDir`；返回 `{ moved }`。
2. `#pruneArchive()`：返回 `result`（便于汇总日志）。
3. 新增 `#pruneTrash()`：回收站二次清理。
   - 阈值：`trashRetentionDays`（默认 30 天）+ `trashMaxBytes`（默认 512 MiB，0=不限）；
   - **只认 `YYYY-MM-DD` 形式的日期桶名**，别的名字一律不碰；
   - 按日期升序，"遇到第一个未过期的就停"；大小超限时也只从最老的开始补删；
   - 真删前把 `回收到多少 KiB / 几个桶` 写进 debug + `stage:'archive'` trace。
4. 新增 `#runRetentionSweep(reason)`：一条日志汇总三道清理（图片/归档/回收站）。
5. 新增 `#startRetentionSweeper()`：`setInterval` 按 `retentionSweepHours`（默认 24h）定时跑；
   timer 进 `this.timers`（`stop()` 会清）。
   测试缝：环境变量 `QQ_RETENTION_SWEEP_MS` 可把间隔压到毫秒级。
6. 配置：新增 `trashRetentionDays` / `trashMaxBytes` / `retentionSweepHours`；
   修正 `imageTrashDir` 的描述（原写"回收站永不自动清理"，现在不成立了）。

### 验证
`test/retention-unit.mjs`（新增，12 项）：
- 过期图片/引用/tts 移出原目录、新鲜文件不误清；移入的是**当天**日期桶；
- 超 30 天的回收站桶被真删、今天的桶保留、**非日期名目录一律不碰**；
- 大小上限：超限时先删最老的桶、上限内保留较新的；
- **定时**：启动清理之后再造一个过期桶，靠周期那一轮清掉（不重启）。
`npm run test:session` 全绿：workspace 18 / session-ownership 44 / retention 12。

## 人格注入：从"裸 coding assistant"改回可配置人设（2026-10-09，用户报障"群里怎么这么凶"）

### 现象
群里（guest 只读角色）说话又长又端着、爱纠正人、甩工具名和路径，还会用 Markdown ——
与工作区 `AGENTS.md` 明令的"群里说人话 / 不许 Markdown / 不确定别编造"完全相反。
更严重的一次：它编了 15 条假"电棍语录"，被识破后自己认账。

### 根因（两条同时成立，缺一不可）
1. **preset 的 persona 写了 `complete: true`**
   `@deepseek-ai/dsh-system-prompt` 的 `assemble()` 里，凡标了 complete 的 section 会成为
   **唯一**生效的 system prompt：
   ```js
   sections: completeSection === void 0 ? transformed.sections : [completeSection],
   ```
   于是桥接自己注册的 `qq-onebot-bridge` 规则段（群里说人话、不许 Markdown、
   不确定就搜/别编造、只读访客说明…）被**静默丢掉**；`includeRuntimeContext: false`
   又把运行时上下文一并清空。
2. **preset 没挂 `agent-instructions`**，且访客 cwd 向上找不到项目根
   预设是自包含插件表：上游 `standard` 预设里有 `agent-instructions`，我们的 QQ 预设没有；
   而它默认只认 `.git` 作项目根标记，访客 cwd 是 `~/qq-users/qqguest`，
   向上没有 `.git` → 根回退成 cwd → `~/AGENTS.md` **永远加载不到**。

实测证据：10 个 QQ 会话（owner + guest）的 `system/message` 都只有 46 字节，
内容就是 `You are a helpful software engineer assistant.`，没有任何规则段 / 指令注入。

### 改动
**profile（`~/.dsh/profiles/web/cordis.patch.yml`，两个 preset + 本插件 config）**
1. 两个 QQ preset 的 persona 去掉 `complete: true` 和 `includeRuntimeContext: false`，
   底座身份改成中性的一句 `You are a helpful assistant.`（人设改由桥接注入）；
2. 两个 preset 补挂 `agent-instructions`，并把项目根标记扩成 `['.git', 'AGENTS.md']`，
   这样访客 cwd 也能向上命中 `~/AGENTS.md`（已用同规则脚本离线验证）；
3. 本插件 config 新增 `persona` 块（见下）。

**桥接（`lib/bridge.js`）**
4. 新增 `#personaEnabled()` / `#personaConfig()` / `#personaFile()` / `#resolvePersona()` /
   `#registerPersonaSection()`，在 `#installSession` 里按角色注册 `qq-persona` 段；
5. 段的位置：紧跟 `DEPLOYMENT_PERSONA_PREFIX` 之后（`getSectionOrder(...) + 0.5`），
   让"你是谁"和"你在这怎么说"连在一起；
6. 段文本注册成**函数**：DSH 每次组装请求都会调它 → **改 persona 文件下一句话就生效**，
   不用重启宿主、不用新建会话；读文件带 `mtimeMs + size` 缓存，既省 IO 又能识别同长改写；
7. 任何一级读不到都逐级降级，最后兜底 `DEFAULT_QQ_PERSONA`，不让"人格"把会话搞崩。

### 配置（profile 里本插件 config.persona）
```yaml
persona:
  enabled: true                     # false = 完全不注入（一键回退到 preset 自带身份）
  dir: ~/qq/config/persona   # 人设文件目录（可选）
  owner: 私聊人设（文件读不到时的兜底）      # 也可短句兜底
  guest: 群聊人设
  extra: 公共追加
  chats:                            # 按会话覆盖（chatKey 形如 g:<群号> / u:<QQ号>）
    "g:<群号>": 本群专属人设
```
文件命名（放 `dir` 下，**文件优先于同名字段**）：
`owner.md` / `guest.md` / `default.md` / `extra.md` / `chat-<chatKey>.md`（`:` 等字符折叠成 `_`）。
解析优先级（具体 > 泛化）：
`dir/chat-<key>.md` → `chats.<key>` → `dir/<role>.md` → `<role>` → `dir/default.md` → `default` → 内置；
最后永远追加 `extra`（`dir/extra.md` → `extra`）。

### 测试
`test/persona-unit.mjs`（新增，19 项）：段注册与顺序、函数式文本（热更新）、文件优先于配置、
按会话优先于按角色、`extra` 追加、无配置走内置兜底、目录不存在逐级降级、
没有 `getSectionOrder` 时用兜底顺序、`enabled:false` 完全不注册（但规则段照旧注册）。
`npm run test:session` 全绿：workspace 18 / session-ownership 44 / retention 12 / persona 19。

### 怎么改人设
直接编辑 `~/qq/config/persona/{owner,guest,extra}.md` —— 下一句话生效。
临时给某个群单独设定：写 `dir/chat-g_<群号>.md`。要整体关掉：`persona.enabled: false`。

## 开发群：按群升级角色 `identity.groupRoles`（2026-10-09，用户要求）

### 需求
用户要一个"开发群"：该群里的任何人都拥有和主人私聊一样的权限（能改代码）。
用户明确表示完全信任该群，因此接受"整群升级"的语义。

### 为什么只能"整群"
角色是在**会话**粒度上固化的（决定 preset / cwd / permission preset / 工具面），而一个群
共享同一条会话 —— 想按发言人切角色做不到（owner 说一句话就会把整个群会话提升到全权限）。
所以 `groupRoles` 的语义就是：这个群整体按哪个角色跑。

### 实现（lib/bridge.js `#identityConfig()`）
```yaml
identity:
  groupRole: guest              # 默认：所有群仍是只读访客
  groupRoles:                   # 按群覆盖（数字或字符串群号都能对上）
    "176628359": owner
```
- `roleFor()` 先查 `groupRoles[String(groupId)]`，命中就用它，否则回落到 `groupRole`；
- **fail-closed**：只认 `owner` / `guest`，其它值（`admin`、`true`、数字…）一律按 guest，
  配置写错不会意外提权；
- 启动时 `#logDevGroups()` 打一条醒目警告，把"整群 owner"的群号列出来（可审计）：
  `[本地补丁] 开发群已启用（整群 owner 全权限，群里任何人都等于主人）：176628359`
- 收回：删掉 `groupRoles` 那一行（或改成 `guest`）再重启宿主。

### 风险（写在这里，别事后才发现）
- 群里任何人 = 主人：能执行 shell、读写 `/home/宿主用户/dshbot` 下任何文件、danger-full-access；
- 群会话多人共享上下文，互相会看到对方的会话历史；
- 没有 per-sender 粒度；只能靠 `allowGroups` 决定"这个群能不能用机器人"。

### 测试
`test/group-role-unit.mjs`（新增，16 项）：开发群拿到 qq-coding + owner cwd +
danger-full-access 且**不**施加 guest 限制；普通群仍是 qq-readonly + 访客 cwd + restrict；
私聊角色不受影响；`admin`/`true` 等非法值 fail-closed 到 guest；数字/字符串群号都能命中；
启动告警包含群号。
`npm run test:session` 全绿：workspace 18 / session-ownership 44 / retention 12 / persona 19 / group-role 16。

## 群聊命令的「@机器人」前缀归一化（2026-10-09，用户报障"群里的 /ws 不生效"）

### 现象
群里 @机器人 之后发 `/ws`（`/help`、`/status` 同理），机器人不认命令，整条被当成聊天丢给模型；
私聊发同样的命令一切正常。

### 根因
- 段格式解析（`lib/onebot.js` 的 `parseMessage` 数组分支）会把 at 段渲染进正文：
  真机抓到的就是 `@<机器人QQ号> /ws`（昵称拿不到时是 `@QQ`，拿到时是 `@昵称(QQ)`）；
- 桥接里所有斜杠命令都按行首锚定（`^[\/／]命令`），命令不在行首 → 认不出；
- 已有的 v0.5.9 归一化（`#textMentionName`）只覆盖 `atMe !== true`（文本 @ 名字）那条路，
  **真 at 段**这条路没人管 —— 所以群里 @机器人 打命令全军覆没。

### 改动（`lib/bridge.js`，备份 `lib/bridge.js.bak-atprefix-<时间戳>`）
1. 入站文本归一化那一段（`const text = message.text.trim()` 之前）补一个 `else if`：
   群聊时 `message.text = this.#stripSelfMention(message, message.text)`；
2. 新增 `#stripSelfMention()` / `#isSelfMentionTag()`：只在 **群聊 + `atMe === true`** 时动手，
   只剥这两种行首 `@`：① 就是机器人自己（QQ 号 / `昵称(QQ)` / 已学到的机器人名）；
   ② `@` 后面紧跟斜杠命令（命令优先于 @ 语义）。最多剥两层，防客户端重复渲染。
   `@某人 你好` 这类普通聊天原样保留。

### 行为
- 私聊、非群聊、没 @ 机器人的群消息：完全不变；
- 剥掉之后模型看到的正文不再带 `@<机器人QQ号> ` 这一截（顺手去噪）；
- **要重启宿主才生效**：profile 的 `dsh-hmr` 配的是 `root: []`，插件代码不走热重载，
  只有 profile 配置是 live reload。

### 验证
- `test/group-command-prefix-unit.mjs`（新增，7 项）：`@机器人 /ws` 被当命令、`@机器人 你好` 剥前缀、
  `@别人 /ws` 仍认命令、`@别人 你好` 不误伤、私聊不受影响、未 @ 机器人的群消息仍然静默；
- 回归：workspace 18 / guards 12 / group-role 16 / engage-bridge 90 / acceptance 75 全绿；
- `commands-unit` 里 `MC 离线可用` 1 项失败：已用 `git worktree` 拉 HEAD 版本复现同样的失败，
  与本次改动无关（本地 ping 127.0.0.1:1 的措辞断言）。

### 回滚
`cp lib/bridge.js.bak-atprefix-<时间戳> lib/bridge.js`，再重启宿主。

### 追加：命令在前、@ 在后也认（2026-10-09 20:5x，真机 `/status @机器人`）

- 现象：群里发 `/status @<机器人QQ号>`（先打命令再 @ 机器人，很自然的顺序）——命令是整串相等匹配，
  尾部留着 ` @<机器人QQ号>` 就认不出，整条被当成聊天丢给模型。上一版只剥行首的 @，没管行内/行尾。
- 改动（`lib/bridge.js`）：`#stripSelfMention()` 在剥完行首之后，追加
  `#stripSelfMentionAnywhere()` —— 去掉正文里任意位置"机器人自己的 @"（`@QQ` 与 `@昵称(QQ)` 两种渲染，
  外加已学到的机器人名），并收掉多余空格。**只动机器人自己的 @**，别人的 @（如 `/禁言 @某人` 的目标）保留。
- 测试：`test/group-command-prefix-unit.mjs` 增至 11 项，新增「命令尾部 @机器人 仍认命令」「行尾自我 @ 被去掉」
  「别人的 @ 原样保留」。（顺带修掉测试里的一个坑：私聊会话创建后 `built[last]` 不再是群会话记录，
  改断言回复文本。）
- 验证：11 个测试文件全绿（workspace 18 / session-ownership 44 / retention 12 / persona 19 /
  group-role 16 / guards 12 / engage-bridge 90 / acceptance 75 / group-command-prefix 11 / acl 52 / paths 16）。

### 追加：主体隔离（每主体一个目录）+ 受限读插件路径修复（2026-10-09 21:0x）

需求 D-2：guest 只能读自己范围内的东西，不能互相读。

- **缺陷**：所有 guest 共用一个 `qq-users/qqguest`（profile 里显式配的 + 代码默认都是它），
  而这个目录同时是"会话工作目录 + 受限读工具根 + 可发送文件根"——于是 guest A 能读 guest B、
  群 A 能读群 B 的文件。
- **改动**（`lib/bridge.js` + `lib/paths.js`）：
  1. guest 的 cwd 按主体派生：`subjects/u<QQ>`（私聊）/ `subjects/g<群号>`（群聊），
     开关 `identity.perSubjectDirs`（默认 true；false = 退回共享目录的旧行为）；
  2. 显式配了 `identity.roles.guest.cwd` 又开着 perSubjectDirs 时，启动打一条 warn 说明它被忽略；
  3. 群里仍是"一个群一条会话"，所以**同群成员之间不隔离**（D-3 既有取舍）。
- **顺带修的坑**：`dsh-tool-fs-jailed`（guest 受限读工具）用相对路径 `../../plugins/...` 动态 import，
  源码从 `dshbot/qq/qq-onebot-bridge` 搬到 `dev/dsh-qq-onebot-bridge` 之后**悄悄失效**——
  表现是 guest 会话没有任何读工具，日志里只有一行 debug。现在按候选顺序找
  （显式 config.jailedFsPluginFile → 仓库 plugins/ → dev/dsh-plugins/ → cwd/qq/plugins/），
  找不到就**明确 warn** 并 fail-closed；插件本体已收编进 `dev/dsh-plugins/`（提交 64e32c2）。
- **测试**：新增 `test/subject-isolation-unit.mjs`（16 项）：群 A/群 B/私聊三个不同目录、同群复用
  不漂移、owner 不受影响、`perSubjectDirs:false` 回旧行为、插件候选路径与 fail-closed。
  `persona-unit` / `group-role-unit` 显式关掉逐主体目录（它们测的是人格与角色，不是路径策略）。

### 追加：门禁收编到统一判定点 #canRun（2026-10-09 21:2x，等价迁移）

之前"谁能干什么"散在三处：`#isAdmin` 白名单（11 处）、`#roleOf().guest`（10 处）、`config.xxxEnabled`
（240 个键）。现在命令/动作授权统一走 `#canRun(message, <能力 id>)`：

- `lib/acl-policy.js`（新增）：把现有配置翻译成策略 —— `identity.map` 的 owner → **admin**
  （owner 是 admin 的历史别名，D-11）、`adminUsers` 名单 → admin（D-5）、`groupRoles` → 群主体角色；
  认不出的角色名按 guest（fail-closed）。`identity.enabled !== true` 时用内置 `legacy` 角色兜底：
  **会话能力照旧全开（等于旧 owner），但命令授权不跟着放大**（旧代码在这种模式下命令侧仍是白名单）。
- `lib/acl.js`：新增 `legacy` 内置角色 + `defaultRoleByKind`（人/群各自的默认角色）。
- `lib/bridge.js`：新增 `#aclPolicy()`（5 秒缓存）、`#canRun()`（能力开关 + PDP）、
  `#subjectOfSender()`（命令按发言人判，群里可以分人）、`#subjectOfChat()`（会话能力面按会话判）；
  `#isAdmin()` 降级为 `#canRun('admin.config')` 的薄包装，语义 = "这个发言人有 admin 身份"。
  已迁移的站点：`/ws`、`/handoff`、词库、日报、好友列表、播报、主动戳、敏感词豁免、
  以及管理命令块（`/mute /kick /clear /公告 /精华 /名片 /头衔 /全员禁言 /退群` **逐个按自己的权限点**）。
- 判定结果会写 debug 日志（`canRun deny <能力> subject=<主体> reason=... missing=... denied=...`），
  排障不用猜。
- 测试：`test/acl-gates-unit.mjs`（25 项）：策略翻译单元断言 + 真实命令的等价性
  （超管 `/clear` 生效 / 访客落到模型、`/handoff` 与 `/ws` 的拒绝文案、群里踢人、deny 覆盖、
  多身份取并集、identity 关闭时两条轴分开），并挂进 `npm run test:session`。

### 追加：DSH 插件能力按权限管控（2026-10-09 21:4x，宿主用户 纠正后重做）

宿主用户 的纠正：要管的是 **DSH 插件能力**（文件读写 / shell / 联网搜索 / ECS·n8n·GH 运维 /
会话读取 / 生图），不是 QQ 群管那点权限。上一轮只把 QQ 命令侧收编了，工具面还是写死的
`role.guest` 分支 —— 这次补上。

- `lib/tool-grants.js`（新增）：权限点 → 工具名的映射（单一事实源）。两类必须分别管：
  - `tools[]` = 宿主级/继承工具 → 交给 `agentCtx.tools.restrict({ allow })` 白名单裁剪；
  - `scoped` = 桥接自己注册的工具（受限读 / 联网 / qq_* / 生图）→ **没权限就不注册**
    （restrict 管不着 scoped 注册，只挡宿主全局工具）。
  带范围的权限点（`tool.fs.read:*`）判定时落到**本主体**（问的是"他范围内的读权限"）。
- `lib/bridge.js`：
  - `#toolSurface(route)` = 会话主体的工具面；`#presetForSurface()` **权限驱动选 preset**：
    有 shell / 写文件权限才允许挂完整 preset —— `qq-coding` 的 bash 是 scoped 注册，
    restrict 挡不住，"只读角色挂完整 preset"就等于给了 shell；
  - `#applyToolSurface()` 落地：`needRestrict` 时才 `restrict({allow})`（全都要就不裁剪，
    免得宿主以后新增的工具因为我们漏列而消失，管理员尤其不能）；scoped 工具按权限注册；
  - `#toolSurfaceSelfCheck()`：**没授权的危险工具如果还看得见就报警**（假安全必须吵出来）；
  - 旧 `#applyGuestRestrictions` 拆成 `#registerJailedFsTools` + 自检（restrict 统一走上面那条路）。
- 行为变化（有意为之，符合"基础角色仅有读权限"）：只读角色**不再**注册
  `qq_send_image / qq_send_file / qq_send_voice / qq_react / qq_face_*`（出站与表情属于写/动作能力），
  只保留只读查询（`qq_member_info / qq_recent_history / qq_search_history`）+ 自己范围的
  read/glob/grep + 联网搜索。
- 测试：`test/tool-surface-unit.mjs`（26 项）：超管全通且不裁剪、访客没有 bash/write/ECS/n8n/GH/
  session_read/context_handoff、有受限读与联网、没有媒体工具；deny 覆盖后联网被摘；多身份叠加后
  ECS 工具进白名单；会话真实装配（preset=qq-readonly、restrict 白名单、注册了哪些工具）。

### 追加：ACL 落库（SQLite）+ 首次引导 + 命令行（2026-10-09 22:0x）

数据层从"配置翻译"升级到"库为准"，但**没库就回落配置**，所以删库即回滚。

- `lib/acl-store.js`（新增，node:sqlite，零依赖）：
  - 表：meta / roles / permissions（镜像）/ role_permissions / role_denies / role_limits /
    subjects / subject_roles / subject_denies / acl_audit；
  - `loadPolicy()` 输出 PDP 直接能吃的策略；**库里的未知权限点一律忽略**（fail-closed）；
  - 写入口：`setRolePermissions` / `setRoleDenies` / `setSubjectRoles` / `setSubjectDenies`，
    每次写都进 `acl_audit`（谁、什么时候、改了什么、改前改后）；
  - `createAclReader()`：有库用库（按 mtime + 5 秒缓存重载）、没库/库坏回落配置（并 warn）。
- `lib/bridge.js`：`aclEnabled`（默认 true）、`aclDbFile`（默认数据根 `config/acl.db`）、
  `aclBootstrap`（首次启动按当前配置建库 + 导入分配，幂等）。`#aclPolicy()` 现在走库优先。
- `lib/index.js`：新增上面三个配置键。
- `control/bin/qq-acl.mjs`（新增 CLI，控制台将来复用同一套 store）：
  `init / import-config / show / export / assign / grant / revoke / deny / undeny / audit`，
  权限点写错直接拒绝（列全量词表）。
- 角色名归一化统一了一处真 bug：`admin` 现在等同 owner（D-11），
  并且 groupRoles 归一化、`#logDevGroups`、`pickRole` 都改用同一个 `normalizeRoleId()` ——
  否则会出现"挂了 qq-coding 的 preset 却没有 danger-full-access 权限 preset"这种半吊子组合。
- 测试：`test/acl-store-unit.mjs`（26 项）：建库/内置角色/导入/写入+审计/未知权限点忽略/
  导出/读取器回落与 mtime 重载/**端到端**（库里给基础角色补 shell → 该群会话真的挂上能跑 shell 的 preset）。
- 生效顺序（重要）：库存在时**库说了算**，profile 里的 identity 只用于"库不存在时的兜底"和首次引导。
  回滚：删 `qqbot/config/acl.db`（或 `aclEnabled: false`）即回到配置翻译。

### 修：guest 会话的宿主级工具其实一直没被挡住（2026-10-09 23:x，真机日志发现）

- **现象**（真机日志 evidence）：`tool surface g:1062134450: SECURITY LEAK — visible but not granted:
  session_read, context_handoff, ecs_exec, ecs_status, ecs_upload, n8n_status, n8n_deploy_workflow,
  gh_run_list, gh_run_view`。日志里 SECURITY LEAK 从 **2026-10-08** 就一直在报（18 次），
  "自检通过" 一次都没有 —— 也就是说这条漏洞在本次重构之前就存在。
- **根因**（两级）：
  1. `tools.restrict()` 要求白名单里的名字都是**可限制的全局工具**；我们给的
     `[read, glob, grep, web_search, web_fetch]` 里 read/glob/grep 是 preset 层、
     web_search/web_fetch 是桥接 scoped 注册 —— 真机上直接抛
     "names unknown global tools"，**裁剪整段失效**；旧代码写的是 `allow: []`（不抛，能生效），
     我改成白名单之后连那部分都失效了 → 这是本轮引入的回退，已修。
  2. 更根本的：`restrict` 只能挡**全局**工具，宿主级插件注册进会话的工具
     （ecs / n8n / gh / session_read / context_handoff）根本挡不住；
     而失败只写了 `logger.warn`，桥接 debug 日志里看不到，所以漏了一整天没人发现。
- **修法**：
  1. restrict 失败自动回落 `{ allow: [] }`（把可限制的全局工具全挡），
     并且把"用了什么/为什么回落"写进 **debug 日志**（不再只写 logger.warn）；
  2. 真正的兜底：注册 `tools.guard()` —— 按工具面的**允许集合拒绝执行**任何未授权工具，
     guard 对任何层级都生效，绕不过去；理由里写清是哪个主体；
  3. 自检措辞纠正：可见 ≠ 可执行（guard 会拒），真正的告警改成"guard 注册失败"。
- **测试**：`test/tool-surface-unit.mjs` 增至 32 项，新增 guard 语义（放行 read/web_search、
  拒绝 ecs/n8n/gh/session_read/context_handoff/bash/write、理由含主体、无名字不插手、
  超管不注册 guard）。

### 追加：把"声明了但没接"的权限点接上（2026-10-09 23:4x，SPEC 四）

- **persona.text**：以前声明了但代码不判 → 现在 `#installSession` 里按工具面决定要不要注入人格；
  没这个权限就不注入（会话本身照常，桥接规则段还在）。
- **qq.write.\***：出站写动作在**执行期**再判一次（新增 `#writeGate`）：图片/文件/语音/撤回四个工具
  在真正发出去之前判 `qq.write.image` / `.file` / `.voice` / `.recall`。
  为什么注册期判了还要判：会话能力面是创建时固化的，**控制台改了权限之后已注册的工具不会消失** ——
  执行期这一刀才是"改动立即生效"的保证（代价：会话里已注册但被禁的工具会明确报"权限不足"）。
- **限额**：生图的冷却/日限/提示词上限优先取**角色限额**（多身份取最宽松），没配才回落配置值。
- **其余命令走 canRun**：/export、/找、/识图、/相册、/取（群文件）、签到、运势、骰子、积分、统计、
  MC、小游戏、投票、待办、/读（TTS）等 20 处命令分支都加了能力判定；
  命令按**发言人**主体判（D-8），所以 deny 要压在 `user:<QQ>` 上，压在群主体上不生效（有测试钉住）。
- **修一个真的判定主体 bug**：`#subjectOfChat()` 原来只认 `groupId`，而出站 route 只有 `targetId`
  → 出站门禁把群会话算成 `group:`（空 id），落到默认角色上，等于没判。现在兼容两种入参。
- 测试：`test/acl-enforcement-unit.mjs`（10 项）覆盖上面四条 + 出站执行期拦截 +
  "群主体 deny 不影响命令判定"（D-8 的粒度）。18 个测试文件全绿。

### 追加：控制台补齐 + 语料库抽象层（2026-10-10 00:xx，SPEC 二/三）

这一轮做的是 SPEC 里剩下的两块：**控制台后三页 + 数据模型补表** 和 **语料库那一层**。

**1. ACL 库升到 schema v2（`lib/acl-store.js`）**

- 新增五张表：`resources` / `resource_grants`（可授权资源：外部服务、目录、共享只读区）、
  `corpora` / `corpus_bindings`（语料资产与主体绑定）、`sessions`（主体 → 会话 → 生效能力面快照）。
  全是 `CREATE TABLE IF NOT EXISTS`，老库打开时自动补齐，不用迁移脚本。
- `loadPolicy()` 现在把 resources / corpora / corpusBindings 一起读进策略快照 ——
  桥接侧一次 5 秒缓存的读取就够，不再多开连接。
- **写前备份 + 显式事务**（SPEC §5.2 的要求，之前一直欠着）：
  每个配置类写操作（角色权限/deny、主体分配/deny、资源、语料、绑定）落库前先
  `wal_checkpoint` + 拷一份 `<file>.bak-<时间戳>`（保留最近 10 份），写操作包在事务里，出错整体回滚。
  运行期快照（sessions）**不**触发备份，否则一天几百份。

**2. 语料库抽象层（新文件 `lib/corpus.js`，SPEC §6）**

- 只实现"资产"这一层：`kind=files` = 一个目录里的若干 `.md/.txt`（按文件名排序，单文件 16KB、总量 64KB 封顶）。
- 生效条件 = **绑定 ∩ 角色白名单**：`corpus_bindings` 选"用哪些"，权限点 `persona.corpus:<id>`（或 `*`）
  决定"能不能用"；被 deny 覆盖也不给。绑了但没权限的会记进 `skipped` 并写明原因（控制台能看见）。
- `resolveCorpusDetailed()`（带原因，控制台预览用）/ `resolveCorpus()`（SPEC 约定的 `[{id,title,text}]`），
  任何异常都吞成"跳过这条"，**绝不让语料把会话搞崩**。
- 桥接侧 `#registerCorpusSection()`：注册成**函数文本**，每轮重新解析 —— 改语料内容/绑定下一句话就生效；
  没绑定就零成本跳过。

**3. 控制台从 4 页变 6 页（`control/lib/acl-console.mjs` + `control/acl-ui.html`）**

- 新增「资源与限额」：资源增删（kind/uri/label）、按角色的 read/write/exec 授权、按角色的限额编辑。
- 新增「人格与语料」：语料增删（id/name/kind/payload_ref/enabled）、按主体绑定、**一键预览生效文本**
  （走 `/api/acl/corpus-preview`，把跳过的语料和原因一并列出来）。
- 「审计」升级为「生效与审计」：上面是会话快照表（主体/会话/角色/只读或可写/工具数/建立与最近时间），
  下面是原来的变更记录，另加"清理 30 天前记录"。见 D-12：这里**只读展示，不碰会话**。
- 新增写操作：`resource-upsert` / `resource-delete` / `resource-grants` / `corpus-upsert` /
  `corpus-delete` / `corpus-bindings` / `session-prune`，全部走词表与存在性校验（fail-closed）。

**4. 会话快照（`#recordAclSession`）**：建会话与续接会话时把"这个会话按哪套能力面建的"
（主体、角色、只读/可写、允许的工具名、scoped 开关）写进 `sessions` 表，
控制台据此回答"哪些会话还在用旧能力面"。写失败只记 debug，绝不拖垮会话。

**测试**：新增 `test/corpus-unit.mjs`（15 项）、`test/acl-store-unit.mjs` +13 项（v2 表、写前备份、
会话快照去重）、`test/acl-console-unit.mjs` +12 项（新接口与预览）。19 个测试文件全绿。

### 追加：共享只读区真的通了 + 资源页不再是装饰（2026-10-10 00:3x）

上一轮结束时说的缺口：`tool.fs.read:shared` 这个权限点授予了，但受限读插件只有一个根
（主体自己的目录），所以共享只读区**实际读不到** —— 声明了没接。这轮补上。

**1. 插件 `dsh-tool-fs-jailed` 支持多根（另一个仓库，提交 bc0001a）**

- 新增 `config.extraRoots = [{ prefix, root }]`，额外根用**显式前缀**寻址：`shared/群规.md`。
  为什么不把两个根拍平成一个：相对路径会静默改投（`群规.md` 到底读哪个根？），前缀是唯一不含糊的写法。
- 带前缀的路径**不允许**改投别的根（`shared/../outside` 直接拒），traversal（glob/grep 的 walk）
  也按对应根做边界校验；共享区目录不存在时只警告，主根照常可用。
- 工具描述里写清有哪几个根、前缀怎么用；错误信息仍然不回显绝对路径。
- 测试 18 → 30 项。

**2. 桥接侧接线**

- `lib/tool-grants.js` 的 `resolveToolSurface()` 多算一个 `sharedRead`
  （单独判 `tool.fs.read:shared`，不能拿 `tool.fs.read:*` 的结果顶替）。
- `#registerJailedFsTools()` 在该权限为真时挂上共享根；顺带改了 `#sharedRoot()`：
  共享区的实际路径**优先取资源 `dir:shared` 的 uri**（相对数据根），没有这条资源才用默认
  `<dataRoot>/subjects/shared` —— 这样控制台改 uri 是真的改到挂载点，而不是只改一行展示数据。
- 只读访客的提示词里补一句"共享只读区用 shared/ 前缀寻址"，免得模型去猜绝对路径。
- debug 日志那行现在会写 `+ shared/<路径>` 或"（无共享只读区权限）"。

**3. 控制台「资源与范围」页不再是装饰**

- 每条资源多两列：**判定点**（`dir:shared → tool.fs.read:shared`、`svc:ecs → tool.mcp.ecs` …；
  没接线的明确标"仅登记"）和**路径是否存在**（dir 类资源按数据根解析 uri 后判）。
- 资源授权列出的角色会先跟判定点核对：只有**真持有该权限点**的角色才算数。
- 资源表仍**不是**授权来源（授权永远在权限点里），页面的职责是"让你看得出接没接上"。

**测试**：`test-jail.mjs` 30 项、`test/tool-surface-unit.mjs` 32 → 37 项
（新增 sharedRead 的三态 + 共享目录真的被建出来 + 工具描述里出现 shared/）、
`test/acl-console-unit.mjs` 39 → 43 项。已知与本次无关的红：`retention-unit` 的
"移入回收站的是今天的日期桶"在本地时间跨过 0 点后必红（测试用 UTC 日期、代码用本地日期），
改动前后一致。

### 修复：控制台给主体挂自定义角色会被改写成 guest（2026-10-10）

- **现象**：控制台里给 `group:10001` 勾 `gq`，保存后还是 guest。
- **根因**：`acl-store.setSubjectRoles()` 把每个角色 id 都过了 `normalizeRoleId()` —— 那个函数
  的语义是"把 **profile 配置**里的 owner/guest 翻译成角色"，认不出的一律给 guest。
  于是自定义角色（gq）一保存就被改写成 guest。审计里是铁证：`set-subject-roles … ["guest"]`，
  而界面勾的是 gq。
- **修法**：
  1. `canonicalRoleId(id, knownIds)`：**先认库里真实存在的角色**（自定义角色原样保留），
     认不出才试历史别名（`owner` → `admin`），再认不出返回 ''（调用方丢掉，fail-closed）；
  2. `setSubjectRoles()` 用它替换 `normalizeRoleId()`；
  3. 控制台的 `subject-roles` 先校验角色存在，不存在的直接 400 并列出可用角色 ——
     不再"悄悄换算成 guest"；
  4. 控制台主体编辑页显示"库里当前保存的是：…"，保存后提示 `已保存 <主体> → <实际角色>`。
- **测试**：acl-store-unit 39 → 44（自定义角色原样保存、owner 别名仍映射 admin、
  认不出的角色被丢掉、多身份并集）；acl-console-unit 43 → 48（挂自定义角色 200 且回显 gq、
  挂不存在的角色 400、被拒绝的写入不改库）。

### 控制台交互重做 + 真浏览器验收（2026-10-10）

**1. 交互：编辑 / 保存 / 取消（宿主用户 要求：不编辑时不可勾选）**

每个可编辑区块（权限矩阵、主体分配、资源授权、限额、语料绑定）都是同一套：
- 非编辑态：所有输入 **disabled**（点不动），只显示「编辑」
- 点「编辑」→「保存」「取消」出现，输入可用；改动后显示「● 有未保存改动」
- 「保存」只提交这一次改动，成功后 toast 回显**实际写进库的内容**（例如"已保存 group:10001 → gq"）
- 「取消」直接丢弃并回到库里当前值；切换页签/切换角色/刷新时有未保存改动会先问一句
- 键盘：Ctrl+S 保存当前编辑中的区块，Esc 取消

**2. 一批体验优化**

- 权限矩阵：搜索（名称或 id）、只看已勾选、按域全允许/清空、分组折叠、每域"已勾/总数"
- **带范围的权限点终于能在界面上填范围了**：`tool.fs.read:own, shared`、`persona.corpus:lore`
  （以前只给了 `base:*` 模板，想给某个语料开权限只能改库 —— 又一个"声明了但用不了"）
- 角色下拉记住上次选择（localStorage）；新建角色后自动切过去 —— 默认停在 admin 上最容易改错角色
- 主体分配：打开即进入编辑态；显示"库里现在保存的是…"，保存后回显实际角色
- 资源页：判定点（`dir:shared → tool.fs.read:shared`）、路径是否存在、"仅登记"标记
- toast 通知：成功 3 秒自动消失，**失败一直留着**（以前错误 4 秒就没了，容易错过）
- 请求期间有全屏遮罩，防止连点；空状态都有明确指引

**3. 真实浏览器端到端（Playwright + 真 Chromium）**

新增独立小项目 `/home/宿主用户/dev/console-e2e`（不把 Chromium 依赖塞进零依赖的桥接仓库）：
- 每条用例同时断言 **界面** 和 **SQLite**，"界面勾了 A 库里存了 B"这类问题才抓得住
- 覆盖：页面/页签、矩阵编辑保存、带范围权限点、**回归（挂自定义角色 gq 必须存成 gq）**、
  取消不落库、未保存改动守卫、搜索/过滤/分组按钮、资源、限额、语料绑定与预览、生效与审计、能力视角
- 另有 `tests/live.spec.mjs`：对**线上那台 8798** 的真实浏览器只读冒烟（不改配置）
- 本机没 root、没 libasound：用 `apt-get download libasound2t64` + `dpkg-deb -x` 解到
  `~/.local/chrome-deps`，由配置设 `LD_LIBRARY_PATH` 绕过

**4. 这轮 E2E 抓出来的真 bug（都不是"测试写错了"）**

- 重渲染之后没有重新套用"非编辑态不可改" → 切角色后复选框又能点了
- 打开主体后「编辑」按钮一直是 disabled（永远进不去编辑）
- 带范围权限点的 base 算错（`slice(0,-1)` 留下冒号）→ 范围输入框绑不上、语料权限填不了
- `cropSubjectSync is not defined`（拼写错误）→ 语料页填主体直接抛异常，绑定区永远"先填主体"
- `renderMatrix` 里对 Set 调 `.filter()` → 矩阵整块渲染不出来
