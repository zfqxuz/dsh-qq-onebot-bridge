/**
 * 权限点词表（单一事实源）。
 *
 * 背景与设计见 /home/zfq/dshbot/qq/SPEC-rbac-console.md：
 *   - 能力（命令 / agent 工具 / QQ 动作 / 群管）都要先在这里声明所需权限；
 *   - 角色 → 权限是数据（SQLite），本文件只提供"有哪些权限点"这个事实；
 *   - 控制台渲染权限矩阵时读的就是这里，不允许"界面一套、代码一套"。
 *
 * 命名：`<域>.<对象>.<动作>`，可选 `:<scope>` 范围后缀（目录、主体、资源 id）。
 *   cmd.chat           命令类
 *   tool.fs.read:<scope>   agent 工具（带范围）
 *   qq.write.message       出站动作
 *   group.ops.kick         群管理动作
 *   admin.config           管理/配置类
 *   persona.corpus:<id>    语料资产
 *
 * 规矩：
 *   1. 权限 = 能不能做；"能做多少"用 limits（见 acl.js 的 LIMITS），不塞进权限点；
 *   2. 范围一律用 `:scope` 后缀，不做通配符语法（唯一例外是 deny 里的 `*`）；
 *   3. 这个文件不认识任何别的模块，保持纯数据 + 纯函数，便于单测。
 */

/** 域 → 中文名（控制台分组用）。 */
export const PERMISSION_DOMAINS = {
  cmd: '命令',
  tool: 'agent 工具',
  qq: 'QQ 动作',
  group: '群管理',
  admin: '管理配置',
  persona: '人格与语料',
}

const p = (id, kind, group, label, desc = '') => ({ id, kind, group, label, desc })

/**
 * 全部权限点。`kind` 取值：
 *   command  桥接层命令（不进 agent 会话，按发言人判定）
 *   tool     agent 会话里的工具（按会话判定，会话创建时固化）
 *   action   出站动作 / 群管理动作（执行前判定）
 *   config   配置与管理类
 *   asset    资产（带 scope）
 */
export const PERMISSIONS = [
  // ── 命令：对话基础 ─────────────────────────────────────────────
  p('cmd.chat', 'command', '对话基础', '对话', '最基础的一问一答（群里 @ 之后说话）'),
  p('cmd.help', 'command', '对话基础', '帮助菜单'),
  p('cmd.status', 'command', '对话基础', '会话状态', '/status'),
  p('cmd.health', 'command', '对话基础', '运行诊断', '/health'),
  p('cmd.new', 'command', '对话基础', '开新会话', '/new'),
  p('cmd.summary', 'command', '对话基础', '总结本会话', '/summary'),
  p('cmd.reminders', 'command', '对话基础', '提醒', '/reminders 与「30分钟后提醒我」'),
  p('cmd.recall', 'command', '对话基础', '撤回自己的消息', '/撤回'),

  // ── 命令：内容与查询 ───────────────────────────────────────────
  p('cmd.history.search', 'command', '内容查询', '搜历史', '/找 关键词（仅本会话归档）'),
  p('cmd.groupinfo', 'command', '内容查询', '群信息', '/荣誉 /公告 /群精华 /群信息'),
  p('cmd.members', 'command', '内容查询', '成员查询', '/成员'),
  p('cmd.groupfiles', 'command', '内容查询', '群文件', '/文件 /取'),
  p('cmd.album', 'command', '内容查询', '群相册', '/相册'),
  p('cmd.ocr', 'command', '内容查询', '识图', '/ocr'),
  p('cmd.export', 'command', '内容查询', '导出聊天记录', '/export'),
  p('cmd.mc', 'command', '内容查询', 'MC 服务器状态', '/mc'),

  // ── 命令：互动玩法 ─────────────────────────────────────────────
  p('cmd.checkin', 'command', '互动玩法', '签到', '签到 / 签到榜'),
  p('cmd.fortune', 'command', '互动玩法', '运势抽签', '今日人品 / 运势 / 抽签 / 塔罗'),
  p('cmd.dice', 'command', '互动玩法', '骰子与抽人', '.r 3d6 / /抽一个'),
  p('cmd.points', 'command', '互动玩法', '积分', '/积分 /排行榜 /转账'),
  p('cmd.game', 'command', '互动玩法', '小游戏', '接龙 / 猜数字'),
  p('cmd.vote', 'command', '互动玩法', '投票', '/vote'),
  p('cmd.todo', 'command', '互动玩法', '待办', '/todo'),
  p('cmd.stats', 'command', '互动玩法', '活跃统计', '/统计 /周榜'),
  p('cmd.reactions', 'command', '互动玩法', '表情回应统计', '/赞榜 /谁赞了'),

  // ── 命令：创作 ────────────────────────────────────────────────
  p('cmd.image', 'command', '创作', '生图', '/画 <描述词>'),
  p('cmd.tts', 'command', '创作', '语音朗读', '/读「文字」'),
  p('cmd.stt', 'command', '创作', '语音转文字', '引用语音转文字'),

  // ── 命令：管理 ────────────────────────────────────────────────
  p('cmd.workspace', 'command', '管理', '工作区切换', '/ws（只给超管）'),
  p('cmd.dailyreport', 'command', '管理', '日报', '/日报'),
  p('cmd.keyword', 'command', '管理', '词库', '/kw'),
  p('cmd.broadcast', 'command', '管理', '播报与 webhook', '/播报'),
  p('cmd.friendlist', 'command', '管理', '好友列表', '/好友（隐私项）'),
  p('cmd.inject', 'command', '管理', '事件注入', 'qq-inject.jsonl（调试用）'),
  p('cmd.console', 'command', '管理', '控制台入口', '控制台 URL / 令牌相关命令'),

  // ── 命令：群管 ────────────────────────────────────────────────
  p('group.ops.mute', 'action', '群管', '禁言', '/mute /unmute /全员禁言'),
  p('group.ops.kick', 'action', '群管', '踢人', '/kick（二次确认）'),
  p('group.ops.clear', 'action', '群管', '清理消息', '/clear'),
  p('group.ops.notice', 'action', '群管', '群公告', '/公告'),
  p('group.ops.essence', 'action', '群管', '设为精华', '/精华'),
  p('group.ops.card', 'action', '群管', '改名片', '/名片'),
  p('group.ops.title', 'action', '群管', '改头衔', '/头衔'),
  p('group.ops.admin', 'action', '群管', '设/撤管理员', '/设管理 /撤管理'),
  p('group.ops.leave', 'action', '群管', '退群', '/退群（慎用）'),

  // ── agent 工具：会话内能力 ────────────────────────────────────
  p('tool.chat.media', 'tool', '会话工具', '收发媒体', 'qq_send_image / qq_send_file / qq_send_voice'),
  p('tool.chat.react', 'tool', '会话工具', '表情回应', 'qq_react'),
  p('tool.chat.members', 'tool', '会话工具', '成员查询', 'qq_member_info'),
  p('tool.chat.history', 'tool', '会话工具', '历史查询', 'qq_recent_history / qq_search_history'),
  p('tool.chat.recall', 'tool', '会话工具', '撤回消息', 'qq_recall'),
  p('tool.chat.faces', 'tool', '会话工具', '表情包', 'qq_face_list / qq_face_send'),
  p('tool.fs.read:*', 'tool', '文件', '读文件（带范围）', '范围 = 主体 id 或 shared'),
  p('tool.fs.write:*', 'tool', '文件', '写文件（带范围）'),
  p('tool.fs.search:*', 'tool', '文件', '搜索文件（带范围）'),
  p('tool.shell', 'tool', '系统', '执行 shell'),
  p('tool.net.search', 'tool', '系统', '联网搜索', 'web_search / web_fetch'),
  p('tool.session.read', 'tool', '系统', '读其他会话', 'session_read'),
  p('tool.context.handoff', 'tool', '系统', '上下文交接', 'context_handoff'),
  p('tool.image.generate', 'tool', '创作', '调用生图后端'),
  p('tool.mcp.ecs', 'tool', '外部服务', 'ECS 运维', 'ecs_exec / ecs_status / ecs_upload'),
  p('tool.mcp.n8n', 'tool', '外部服务', 'n8n 工作流', 'n8n_status / n8n_deploy_workflow'),
  p('tool.mcp.gh', 'tool', '外部服务', 'GitHub Actions', 'gh_run_list / gh_run_view'),

  // ── 出站动作 ──────────────────────────────────────────────────
  p('qq.write.message', 'action', '出站', '发文本'),
  p('qq.write.image', 'action', '出站', '发图片'),
  p('qq.write.file', 'action', '出站', '发文件'),
  p('qq.write.voice', 'action', '出站', '发语音'),
  p('qq.write.poke', 'action', '出站', '戳一戳'),
  p('qq.write.recall', 'action', '出站', '撤回消息'),

  // ── 配置 / 资产 ────────────────────────────────────────────────
  p('admin.config', 'config', '管理配置', '改机器人配置', '插件开关 / 白名单 / 路径'),
  p('admin.acl', 'config', '管理配置', '改权限模型本身', '角色、分配、deny、语料绑定'),
  p('admin.console', 'config', '管理配置', '用控制台', '控制台读写与运维操作（含重启宿主）'),
  p('persona.text', 'asset', '人格与语料', '人格文本'),
  p('persona.corpus:*', 'asset', '人格与语料', '语料资产（带 id）', '范围 = 语料 id'),
]

/**
 * 快查表。
 *   PERMISSION_BY_ID   —— 按词表里的**模板 id**（带 `:*`）索引，例如 `tool.fs.read:*`
 *   PERMISSION_BY_BASE —— 按**基础点**索引，例如 `tool.fs.read`；判定一律走这张
 *     （授予项与需求项都会先去掉范围再查，否则 `tool.fs.read:u1001` 会被当成未知点）
 */
export const PERMISSION_BY_ID = new Map(PERMISSIONS.map((item) => [item.id, item]))
export const PERMISSION_BY_BASE = new Map(PERMISSIONS.map((item) => [basePermission(item.id), item]))

/** 权限点是否在词表里（带范围的授予项也算：比对前先去掉范围）。 */
export function isKnownPermission(id) {
  return PERMISSION_BY_BASE.has(basePermission(String(id ?? '')))
}

/**
 * 拆出 `基础点 + 范围`。`tool.fs.read:s*`（词表里的模板）与 `tool.fs.read:u1001`（实际授予）
 * 的基础点相同，都是 `tool.fs.read`；只有带 `:` 且后缀不是 `*` 的算"实际范围"。
 */
export function splitPermission(id) {
  const raw = String(id ?? '').trim()
  const at = raw.indexOf(':')
  if (at < 0) return { base: raw, scope: '' }
  return { base: raw.slice(0, at), scope: raw.slice(at + 1) }
}

/** 基础点（去掉范围）。 */
export function basePermission(id) {
  return splitPermission(id).base
}

/**
 * 授予项是否满足需求项。
 *   - 基础点必须相同；
 *   - 需求不带范围时，任何范围都满足（`cmd.chat` 这种天然无范围）；
 *   - 授予范围 `*` 匹配一切；否则要求范围完全一致。
 * 判定不含 deny：deny 由 acl.js 的最外层覆盖负责。
 */
export function permissionSatisfies(granted, required) {
  const g = splitPermission(granted)
  const r = splitPermission(required)
  if (g.base === '' || g.base !== r.base) return false
  // 需求不带范围 = "这个基础点整体"，只有同样不限范围的授予（无范围或 `*`）才满足；
  // 范围更窄的授予（如只给了 u1）不能顶替它。
  if (r.scope === '') return g.scope === '' || g.scope === '*'
  // 需求带范围 = 具体到某个范围，不限范围的授予或范围相同的授予都满足。
  if (g.scope === '' || g.scope === '*') return true
  return g.scope === r.scope
}

/** 词表自检：id 唯一、域合法、必填字段齐全。返回问题列表（空 = 通过）。 */
export function validatePermissionTable() {
  const problems = []
  const seen = new Set()
  for (const item of PERMISSIONS) {
    if (!item.id) problems.push('权限点缺少 id')
    if (seen.has(item.id)) problems.push(`权限点 id 重复：${item.id}`)
    seen.add(item.id)
    const { base, scope } = splitPermission(item.id)
    const domain = base.split('.')[0]
    if (!PERMISSION_DOMAINS[domain]) problems.push(`权限点域未知：${item.id}`)
    // 词表里带范围的权限点是"模板"，范围统一写 `*`；实际授予时的范围（主体 id、语料 id）
    // 是运行期数据，不在这里校验。
    if (scope !== '' && scope !== '*') {
      problems.push(`权限点模板的范围必须写 *（实际范围属于授予数据）：${item.id}`)
    }
    for (const key of ['kind', 'group', 'label']) {
      if (!item[key]) problems.push(`权限点缺字段 ${key}：${item.id}`)
    }
  }
  return problems
}
