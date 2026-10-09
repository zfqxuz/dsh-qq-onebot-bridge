/**
 * 权限点 → 具体工具名的映射（"插件能力按权限管控"的落点）。
 *
 * 背景（zfq 2026-10-09 纠正）：要管的是 **DSH 插件能力** —— 文件读写、shell、联网搜索、
 * ECS/n8n/GH 运维工具、会话读取……不是 QQ 群管那点权限。所以这里把
 * `lib/permissions.js` 里的 `tool.*` 权限点，映射成"会话工具面"：
 *
 *   - `tools[]` = **宿主级/继承工具**的名字，交给 `agentCtx.tools.restrict({ allow })` 白名单裁剪；
 *   - `scoped`  = 由桥接自己注册的工具（不受 restrict 影响），必须**按权限决定要不要注册**。
 *
 * 两类必须都管，否则就是假安全：
 *   restrict() 只能挡宿主全局工具；桥接 scoped 注册的（jailed fs / web / qq_*）只能靠不注册来禁。
 *
 * 已知边界（写在前面，别当没这回事）：`qq-coding` preset 里的 **bash 是 scoped 注册**的
 * （见 `#resumeSession` 里那段注释），restrict 挡不住它 —— 所以"没有 shell 权限"的角色
 * **不能挂带 shell 的 preset**，只能挂只读 preset。这也是下面 `requiresFullPreset` 存在的原因。
 */
import { evaluate } from './acl.js'

/**
 * 权限点 → 工具。`scoped` 是"这类能力由桥接自己注册"的标记：
 *   'jailed-fs' —— 根目录受限的 read/glob/grep（dsh-tool-fs-jailed）
 *   'web'       —— web_search / web_fetch（桥接 scoped 注册）
 *   'qq-chat'   —— qq_* 聊天/查询工具
 *   'imagegen'  —— 生图后端调用
 *   'persona'   —— 人格/语料注入（不是工具，但同样按权限开关）
 */
export const TOOL_GRANTS = [
  { perm: 'tool.fs.read:*', tools: ['read', 'glob', 'grep'], scoped: '', label: '读文件' },
  { perm: 'tool.fs.search:*', tools: [], scoped: '', label: '搜索文件' },
  { perm: 'tool.fs.write:*', tools: ['write', 'edit'], scoped: '', label: '写文件' },
  { perm: 'tool.shell', tools: ['bash', 'read_image'], scoped: 'shell', label: 'shell' },
  { perm: 'tool.net.search', tools: ['web_search', 'web_fetch'], scoped: 'web', label: '联网搜索' },
  { perm: 'tool.session.read', tools: ['session_read'], scoped: '', label: '读其他会话' },
  { perm: 'tool.context.handoff', tools: ['context_handoff'], scoped: '', label: '上下文交接' },
  { perm: 'tool.mcp.ecs', tools: ['ecs_exec', 'ecs_status', 'ecs_upload'], scoped: '', label: 'ECS 运维' },
  { perm: 'tool.mcp.n8n', tools: ['n8n_status', 'n8n_deploy_workflow'], scoped: '', label: 'n8n' },
  { perm: 'tool.mcp.gh', tools: ['gh_run_list', 'gh_run_view'], scoped: '', label: 'GitHub Actions' },
  { perm: 'tool.chat.media', tools: [], scoped: 'qq-chat', label: '收发媒体' },
  { perm: 'tool.chat.react', tools: [], scoped: 'qq-chat', label: '表情回应' },
  { perm: 'tool.chat.members', tools: [], scoped: 'qq-chat', label: '成员查询' },
  { perm: 'tool.chat.history', tools: [], scoped: 'qq-chat', label: '历史查询' },
  { perm: 'tool.chat.faces', tools: [], scoped: 'qq-chat', label: '表情包' },
  { perm: 'tool.image.generate', tools: [], scoped: 'imagegen', label: '生图' },
  { perm: 'persona.text', tools: [], scoped: 'persona', label: '人格注入' },
]

/** 会"打开整个宿主工具面"的权限点：只要给了其中之一，就必须挂完整 preset。 */
export const FULL_PRESET_PERMISSIONS = ['tool.shell', 'tool.fs.write:*']

/**
 * 算出某个主体的**工具面**（纯函数，可离线测）。
 *
 * @param {object} policy  策略（acl.js 结构）
 * @param {string} subject 会话主体（`group:<gid>` / `user:<qq>`）
 * @returns {{
 *   subject: string,
 *   allowed: string[],           通过的权限点（含范围模板）
 *   decisions: object,           每个权限点的判定（含 reason / missing，便于解释）
 *   inheritedTools: string[],    允许保留的宿主级工具名（restrict 白名单）
 *   scoped: object,              桥接自己注册的能力开关
 *   requiresFullPreset: boolean, 是否必须挂完整 preset（有 shell / 写文件）
 *   needRestrict: boolean,       是否需要 restrict（= 不是"全都要"）
 *   readonly: boolean            是否只读（没有 shell 也没有写权限）
 * }}
 */
export function resolveToolSurface(policy, subject) {
  const decisions = {}
  const allowed = []
  for (const item of TOOL_GRANTS) {
    // 带范围的权限点（词表里写成 `tool.fs.read:*`）在判定时要落到**本主体**：
    // 问的是"这个人有没有他范围内的读权限"，而不是"有没有全局读权限"。
    const need = item.perm.endsWith(':*') ? `${item.perm.slice(0, -1)}${subject}` : item.perm
    const decision = evaluate(policy, subject, { need: [need] })
    decisions[item.perm] = decision
    if (decision.allowed) allowed.push(item.perm)
  }
  const granted = new Set(allowed)
  const inheritedTools = [...new Set(TOOL_GRANTS.flatMap((item) => (granted.has(item.perm) ? (item.tools ?? []) : [])))]
  const scopedKinds = new Set(TOOL_GRANTS.flatMap((item) => (granted.has(item.perm) && item.scoped ? [item.scoped] : [])))
  const requiresFullPreset = FULL_PRESET_PERMISSIONS.some((perm) => granted.has(perm))
  // "全都要"就不调 restrict：宿主以后新增的工具不该因为我们漏列而消失（管理员尤其不能）。
  const needRestrict = TOOL_GRANTS.some((item) => !granted.has(item.perm))
  return {
    subject,
    allowed,
    decisions,
    inheritedTools,
    scoped: {
      jailedFs: scopedKinds.has('jailed-fs') || granted.has('tool.fs.read:*'),
      web: scopedKinds.has('web'),
      qqChat: TOOL_GRANTS.some((item) => item.scoped === 'qq-chat' && granted.has(item.perm)),
      imageGen: scopedKinds.has('imagegen'),
      persona: scopedKinds.has('persona'),
      shell: granted.has('tool.shell'),
    },
    requiresFullPreset,
    needRestrict,
    readonly: !granted.has('tool.shell') && !granted.has('tool.fs.write:*'),
  }
}

/** 人类可读解释（排障/控制台用）。 */
export function explainToolSurface(surface) {
  const denied = Object.entries(surface.decisions ?? {})
    .filter(([, d]) => d.allowed !== true)
    .map(([perm]) => perm)
  return [
    `主体 ${surface.subject}`,
    `允许 ${surface.allowed.length} 项`,
    `隐藏工具 ${surface.inheritedTools.length} 个`,
    surface.needRestrict ? '需要 restrict' : '不裁剪（全都要）',
    denied.length ? `未授权：${denied.join(', ')}` : '',
  ].filter(Boolean).join('｜')
}
