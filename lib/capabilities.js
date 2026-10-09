/**
 * 能力注册表（单一事实源）：每个能力声明"需要哪些权限""当前由哪个开关/身份把着门"。
 *
 * 为什么要有这张表：
 *   1. 控制台的权限矩阵直接渲染它 —— 界面里的每一项都能在代码里找到出处；
 *   2. P0 阶段"只声明、不改行为"：`gate` 字段如实描述**现在**是怎么拦的，
 *      P1 迁移时用它做等价性断言（迁移前后每个能力的放行结果必须一致）；
 *   3. 新增能力（生图、语料库、以后的任何插件功能）必须先在 `PERMISSIONS` 里落权限点，
 *      再在这里登记一条 —— 这是需求 2 的落地方式。
 *
 * `gate` 取值（现状描述，不是目标模型）：
 *   { kind: 'none' }                     无门禁（人人可用）
 *   { kind: 'flag', key }                纯功能开关：config[key] 为真才提供
 *   { kind: 'adminFlag', flag }          既要开关、又要 adminUsers 白名单（#isAdmin）
 *   { kind: 'notGuest' }                 非 guest 角色（例如 /ws）
 *   { kind: 'guestDenied' }              会话内 guest 拿不到（工具面被 restrict 收走）
 *   { kind: 'whitelist' }                只对白名单会话开放
 */
import { isKnownPermission } from './permissions.js'

const cap = (id, kind, group, label, need, gate = { kind: 'none' }, extra = {}) => ({
  id, kind, group, label, need, gate, ...extra,
})

/** 能力清单。id 约定：`cmd.*` / `intent.*` / `tool.*` / `ops.*` / `media.*` / `sys.*`。 */
export const CAPABILITIES = [
  // ── 命令：对话基础 ─────────────────────────────────────────────
  cap('cmd.chat', 'command', '对话基础', '对话（进 agent）', ['cmd.chat']),
  cap('cmd.help', 'command', '对话基础', '帮助菜单', ['cmd.help']),
  cap('cmd.status', 'command', '对话基础', '会话状态', ['cmd.status']),
  cap('cmd.health', 'command', '对话基础', '运行诊断', ['cmd.health']),
  cap('cmd.new', 'command', '对话基础', '开新会话', ['cmd.new']),
  cap('cmd.summary', 'command', '对话基础', '总结本会话', ['cmd.summary']),
  cap('cmd.recall', 'command', '对话基础', '撤回自己上一条', ['cmd.recall'], { kind: 'none' }, { entry: '/撤回' }),

  // ── 命令：内容与查询 ───────────────────────────────────────────
  cap('cmd.history.search', 'command', '内容查询', '搜历史', ['cmd.history.search'], { kind: 'flag', key: 'historySearchEnabled' }, { entry: '/找' }),
  cap('cmd.groupinfo', 'command', '内容查询', '群信息', ['cmd.groupinfo'], { kind: 'flag', key: 'groupReadEnabled' }),
  cap('cmd.members', 'command', '内容查询', '成员查询', ['cmd.members'], { kind: 'flag', key: 'memberQueryEnabled' }),
  cap('cmd.groupfiles', 'command', '内容查询', '群文件', ['cmd.groupfiles'], { kind: 'flag', key: 'groupFileEnabled' }),
  cap('cmd.album', 'command', '内容查询', '群相册', ['cmd.album'], { kind: 'flag', key: 'albumEnabled' }),
  cap('cmd.ocr', 'command', '内容查询', '识图', ['cmd.ocr'], { kind: 'flag', key: 'ocrEnabled' }),
  cap('cmd.export', 'command', '内容查询', '导出聊天记录', ['cmd.export'], { kind: 'flag', key: 'exportEnabled' }),
  cap('cmd.mc', 'command', '内容查询', 'MC 状态', ['cmd.mc'], { kind: 'flag', key: 'mcStatusEnabled' }),

  // ── 命令：互动玩法 ─────────────────────────────────────────────
  cap('cmd.checkin', 'command', '互动玩法', '签到', ['cmd.checkin'], { kind: 'flag', key: 'checkinEnabled' }),
  cap('cmd.fortune', 'intent', '互动玩法', '运势抽签', ['cmd.fortune'], { kind: 'flag', key: 'fortuneEnabled' }),
  cap('cmd.dice', 'intent', '互动玩法', '骰子与抽人', ['cmd.dice'], { kind: 'flag', key: 'diceEnabled' }),
  cap('cmd.points', 'command', '互动玩法', '积分', ['cmd.points'], { kind: 'flag', key: 'pointsEnabled' }),
  cap('cmd.game', 'intent', '互动玩法', '小游戏', ['cmd.game'], { kind: 'flag', key: 'gameEnabled' }),
  cap('cmd.vote', 'command', '互动玩法', '投票', ['cmd.vote'], { kind: 'flag', key: 'voteEnabled' }),
  cap('cmd.todo', 'command', '互动玩法', '待办', ['cmd.todo'], { kind: 'flag', key: 'todoEnabled' }),
  cap('cmd.stats', 'command', '互动玩法', '活跃统计', ['cmd.stats'], { kind: 'flag', key: 'statsEnabled' }),
  cap('cmd.reactions', 'command', '互动玩法', '表情回应统计', ['cmd.reactions'], { kind: 'flag', key: 'reactionStatsEnabled' }),

  // ── 命令：创作 ────────────────────────────────────────────────
  cap('cmd.image', 'command', '创作', '生图', ['cmd.image', 'tool.image.generate'], { kind: 'flag', key: 'imageGenEnabled' },
    { entry: '/画', limits: ['imageGenCooldownSeconds', 'imageGenDailyLimit', 'imageGenMaxPromptChars'] }),
  cap('cmd.tts', 'command', '创作', '语音朗读', ['cmd.tts', 'qq.write.voice'], { kind: 'flag', key: 'ttsEnabled' }),
  cap('cmd.stt', 'command', '创作', '语音转文字', ['cmd.stt'], { kind: 'flag', key: 'sttEnabled' }),

  // ── 命令：管理 ────────────────────────────────────────────────
  cap('cmd.workspace', 'command', '管理', '工作区切换', ['cmd.workspace'], { kind: 'notGuest' }, { entry: '/ws' }),
  cap('cmd.dailyreport', 'command', '管理', '日报', ['cmd.dailyreport'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('cmd.keyword', 'command', '管理', '词库', ['cmd.keyword'], { kind: 'adminFlag', flag: 'keywordEnabled' }),
  cap('cmd.broadcast', 'command', '管理', '播报与 webhook', ['cmd.broadcast'], { kind: 'adminFlag', flag: 'broadcastEnabled' }),
  cap('cmd.friendlist', 'command', '管理', '好友列表', ['cmd.friendlist'], { kind: 'adminFlag', flag: 'friendListEnabled' }),
  cap('cmd.inject', 'command', '管理', '事件注入', ['cmd.inject'], { kind: 'flag', key: 'injectEnabled' }),
  cap('cmd.console', 'command', '管理', '控制台入口', ['cmd.console', 'admin.console']),
  cap('cmd.handoff', 'command', '管理', '会话交接面板', ['cmd.handoff'], { kind: 'adminFlag', flag: 'adminEnabled' }, { entry: '/handoff' }),

  // ── 群管动作 ──────────────────────────────────────────────────
  cap('group.ops.mute', 'ops', '群管', '禁言', ['group.ops.mute'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('group.ops.kick', 'ops', '群管', '踢人', ['group.ops.kick'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('group.ops.clear', 'ops', '群管', '清理消息', ['group.ops.clear'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('group.ops.notice', 'ops', '群管', '群公告', ['group.ops.notice'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('group.ops.essence', 'ops', '群管', '精华', ['group.ops.essence'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('group.ops.card', 'ops', '群管', '名片', ['group.ops.card'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('group.ops.title', 'ops', '群管', '头衔', ['group.ops.title'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('group.ops.admin', 'ops', '群管', '设/撤管理员', ['group.ops.admin'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('group.ops.leave', 'ops', '群管', '退群', ['group.ops.leave'], { kind: 'adminFlag', flag: 'leaveGroupEnabled' }),

  // ── 会话内工具（按会话能力面判定） ─────────────────────────────
  cap('tool.chat.media', 'tool', '会话工具', '收发媒体', ['tool.chat.media', 'qq.write.image', 'qq.write.file'], { kind: 'guestDenied' }, { tool: ['qq_send_image', 'qq_send_file', 'qq_send_voice'] }),
  cap('tool.chat.react', 'tool', '会话工具', '表情回应', ['tool.chat.react'], { kind: 'guestDenied' }, { tool: ['qq_react'] }),
  cap('tool.chat.members', 'tool', '会话工具', '成员查询', ['tool.chat.members'], { kind: 'guestDenied' }, { tool: ['qq_member_info'] }),
  cap('tool.chat.history', 'tool', '会话工具', '历史查询', ['tool.chat.history'], { kind: 'guestDenied' }, { tool: ['qq_recent_history', 'qq_search_history'] }),
  cap('tool.chat.recall', 'tool', '会话工具', '撤回消息', ['tool.chat.recall'], { kind: 'guestDenied' }, { tool: ['qq_recall'] }),
  cap('tool.chat.faces', 'tool', '会话工具', '表情包', ['tool.chat.faces'], { kind: 'flag', key: 'faceEnabled' }, { tool: ['qq_face_list', 'qq_face_send'] }),
  cap('tool.fs.read', 'tool', '文件', '读文件', ['tool.fs.read'], { kind: 'guestDenied' }, { scoped: true }),
  cap('tool.fs.write', 'tool', '文件', '写文件', ['tool.fs.write'], { kind: 'guestDenied' }, { scoped: true }),
  cap('tool.fs.search', 'tool', '文件', '搜索文件', ['tool.fs.search'], { kind: 'guestDenied' }, { scoped: true }),
  cap('tool.shell', 'tool', '系统', '执行 shell', ['tool.shell'], { kind: 'guestDenied' }),
  cap('tool.net.search', 'tool', '系统', '联网搜索', ['tool.net.search']),
  cap('tool.session.read', 'tool', '系统', '读其他会话', ['tool.session.read'], { kind: 'guestDenied' }),
  cap('tool.context.handoff', 'tool', '系统', '上下文交接', ['tool.context.handoff'], { kind: 'guestDenied' }),
  cap('tool.mcp.ecs', 'tool', '外部服务', 'ECS 运维', ['tool.mcp.ecs'], { kind: 'guestDenied' }),
  cap('tool.mcp.n8n', 'tool', '外部服务', 'n8n 工作流', ['tool.mcp.n8n'], { kind: 'guestDenied' }),
  cap('tool.mcp.gh', 'tool', '外部服务', 'GitHub Actions', ['tool.mcp.gh'], { kind: 'guestDenied' }),

  // ── 出站 ──────────────────────────────────────────────────────
  cap('qq.write.message', 'media', '出站', '发文本', ['qq.write.message']),
  cap('qq.write.image', 'media', '出站', '发图片', ['qq.write.image']),
  cap('qq.write.file', 'media', '出站', '发文件', ['qq.write.file']),
  cap('qq.write.voice', 'media', '出站', '发语音', ['qq.write.voice'], { kind: 'flag', key: 'ttsEnabled' }),
  cap('qq.write.poke', 'media', '出站', '戳一戳', ['qq.write.poke'], { kind: 'flag', key: 'pokeEnabled' }),
  cap('qq.write.recall', 'media', '出站', '撤回消息', ['qq.write.recall']),

  // ── 配置与资产 ────────────────────────────────────────────────
  cap('admin.config', 'sys', '管理配置', '改机器人配置', ['admin.config'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('admin.acl', 'sys', '管理配置', '改权限模型', ['admin.acl'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('admin.console', 'sys', '管理配置', '用控制台', ['admin.console'], { kind: 'adminFlag', flag: 'adminEnabled' }),
  cap('persona.text', 'sys', '人格与语料', '人格文本', ['persona.text'], { kind: 'guestDenied' }),
  cap('persona.corpus', 'sys', '人格与语料', '语料资产', ['persona.corpus'], { kind: 'none' }, { scoped: true }),

  // ── 系统能力（不是给人用的，但也要登记，便于矩阵完整） ─────────
  cap('sys.memory', 'sys', '系统', '会话记忆', [], { kind: 'flag', key: 'memoryEnabled' }),
  cap('sys.historyArchive', 'sys', '系统', '消息归档', [], { kind: 'flag', key: 'historyArchiveEnabled' }),
  cap('sys.trace', 'sys', '系统', '遥测 trace', [], { kind: 'flag', key: 'traceEnabled' }),
  cap('sys.verify', 'sys', '系统', '入群验证', [], { kind: 'flag', key: 'verifyEnabled' }),
  cap('sys.welcome', 'sys', '系统', '入群欢迎', [], { kind: 'flag', key: 'welcomeEnabled' }),
  cap('sys.quietHours', 'sys', '系统', '静默时段', [], { kind: 'flag', key: 'quietHoursEnabled' }),
]

/** 能力 id → 能力。 */
export const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((item) => [item.id, item]))

/**
 * 限额词表。`direction` 决定"多身份合并时哪个更宽松"（SPEC D-10：取最宽松）：
 *   'max' — 数值越大越宽松（每日上限、条数上限）
 *   'min' — 数值越小越宽松（冷却秒数、提示长度上限这种"限制性阈值"按下限）
 * `default` 是没有任何角色配置时的兜底（null = 不限）。
 */
export const LIMITS = {
  imageGenCooldownSeconds: { direction: 'min', default: 60, label: '生图冷却（秒）' },
  imageGenDailyLimit: { direction: 'max', default: 20, label: '生图每日上限（张）' },
  imageGenMaxPromptChars: { direction: 'max', default: 400, label: '生图提示词上限（字）' },
  rateLimitMaxReplies: { direction: 'max', default: null, label: '限流窗口内最多回复条数' },
  dailyMessageLimit: { direction: 'max', default: null, label: '每日消息上限' },
  actionRatePerMinute: { direction: 'max', default: 20, label: '出站写操作/分钟' },
  actionRatePerDay: { direction: 'max', default: 500, label: '出站写操作/天' },
}

/** 注册表自检：id 唯一、need 里的权限点都在词表里、limits 都在限额表里。 */
export function validateCapabilityTable() {
  const problems = []
  const seen = new Set()
  for (const item of CAPABILITIES) {
    if (!item.id) problems.push('能力缺少 id')
    if (seen.has(item.id)) problems.push(`能力 id 重复：${item.id}`)
    seen.add(item.id)
    for (const key of ['kind', 'group', 'label']) {
      if (!item[key]) problems.push(`能力缺字段 ${key}：${item.id}`)
    }
    for (const need of item.need ?? []) {
      if (!isKnownPermission(need)) problems.push(`能力 ${item.id} 引用了不存在的权限点：${need}`)
    }
    for (const key of item.limits ?? []) {
      if (!LIMITS[key]) problems.push(`能力 ${item.id} 引用了不存在的限额：${key}`)
    }
    if (!item.gate || !item.gate.kind) problems.push(`能力 ${item.id} 缺少 gate 描述（P1 迁移要靠它做等价断言）`)
  }
  return problems
}
