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
- 2026-10-08 验证：启用注入 dry-run，向 `u:2493922172` 注入消息触发 resume；日志出现
  `mounted preset qq-coding -> {"id":"qq-coding"}`，随后真实请求的工具表从 17 个变为 24 个，
  新增 `bash/read/write/edit/glob/grep/read_image`，agent 本地 `cat qq-sessions.json` 成功。

## QQ 用户 → 角色身份映射（只读访客模式）（2026-10-08，用户要求）

需求：QQ 号映射到角色身份；`2493922172` → owner（zfq 全权限）；其余（含群聊）→ 共用 guest 只读；
guest 不可写、不可执行、不可读 DSH 配置与其他配置文件；guest 对话权限只能只读、不允许申请提权。
设计文档：`/home/zfq/dshbot/qq/SPEC-identity.md`（已评审 v1.1）。

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

4. 目录：`/home/zfq/dshbot/qq-users/qqguest`（`0700`），guest 的 cwd 与唯一可读/可发送根。

### 未做（与 spec 的偏差，需知悉）

- `read_image` 未实现：需要 `@deepseek-ai/dsh-attachment` 的 `AttachmentId` brand，
  而本地插件按惯例零第三方依赖。guest 目前无读图能力。
- 未挂载 `dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-bash-sandbox`：
  guest 根本没有 shell 与写工具，「只读」由**能力移除**保证（比沙箱策略更强），
  挂载沙箱栈反而会全局替换 `ctx.shell`、影响所有会话。`approval=never` 仍然按会话设置。
- OS 层 uid 隔离未做（无免密 sudo、无 bwrap、DSH 无 per-session uid），见 spec §7。

### 风险

- guest 目录（`qq-users/qqguest`）与桥接同属 zfq，OS 层没有权限边界；隔离完全依赖
  工具面收敛 + `restrict({allow:[]})` + 受限读工具。**若将来给 guest 加任何新工具，必须重新评估。**
- 宿主级工具清单变化（新增危险工具）不会自动被拦：`restrict({allow:[]})` 是白名单式隐藏，
  新工具同样被隐藏，方向是安全的。
- 自检失败会在日志里报 SECURITY LEAK，此时 guest 仍可能拥有危险工具，需要人工介入。

### 验证方式

- 单测：`cd /home/zfq/dshbot/qq/plugins/dsh-tool-fs-jailed && node test-jail.mjs`（18/18）
- 语法：`node --input-type=module --check < lib/bridge.js`
- 运行时：`qq-bridge-debug.log` 搜 `guest` / `tool surface check` / `SECURITY LEAK`

## 联网搜索权限（2026-10-08，用户要求：普通用户和 zfq 都能联网搜索）

需求：owner（zfq）与 guest（普通用户）都具备 `web_search` / `web_fetch`。

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
- 重启：`nohup bash /home/zfq/dshbot/qq/restart-websearch.sh 90 &`
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
     把工作区路径编码成 `~/.dsh/sessions/--home-zfq-xxx--` 的目录名。
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
  `ln -s /home/zfq/node24/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai \
   node_modules/@deepseek-ai`，跑完记得删掉该软链（避免影响宿主解析）。
- 真实数据只读核对：5 个登记工作区都能按 projectKey 找到会话目录与最新会话（runGroup 36 条）。

### 生效方式与回滚

- 代码在宿主重启后生效：`bash /home/zfq/dshbot/qq/restart-dsh.sh`（会中断当前 QQ 会话，随后自动续接）。
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

- 代码与配置都只在宿主重启后生效：`bash /home/zfq/dshbot/qq/restart-dsh.sh 90`
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
哪怕这些会话的 `cwd` 就是 `/home/zfq/dshbot`。

### 根因（实测数据）
- 磁盘上 `sessions/--home-zfq-dshbot--/` 有 16 条会话（13 条 `qq-*` + 3 条 `session-*`），
  header 里 `cwd` 全是 `/home/zfq/dshbot`；
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
