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
