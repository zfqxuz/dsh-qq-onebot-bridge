/**
 * PDP（策略判定点）：把"主体 → 角色集合 → 权限"算成一个是/否。
 *
 * 规则（SPEC-rbac-console.md §4.3，zfq 2026-10-09 确认）：
 *   1. 一个主体可以持有多个角色；
 *   2. **allow 取并集**（多身份"取最高"，多挂身份不会互相削弱）；
 *   3. **deny 在最外层覆盖**（主体级 + 角色级，任何身份都压不过它）；
 *   4. limits（"能做多少"）多身份取**最宽松**（D-10）；
 *   5. fail-closed：解析不出来、权限点不认识、角色不认识 → 不给权限。
 *
 * 本文件是纯函数，不碰 SQLite / 文件 / 网络 —— 存储层（acl-store.js）负责喂数据，
 * bridge 只调用 evaluate()。这样判定逻辑可以完全离线单测。
 */
import { basePermission, isKnownPermission, permissionSatisfies, splitPermission } from './permissions.js'
import { LIMITS } from './capabilities.js'
import { PERMISSIONS } from './permissions.js'

/** `legacy` 角色排除掉的权限点：这些在旧代码里是"命令授权"（isAdmin / 超管专属），不跟着 owner 角色走。 */
const LEGACY_EXCLUDED = new Set([
  'admin.config', 'admin.acl', 'admin.console',
  'cmd.handoff', 'cmd.keyword', 'cmd.broadcast', 'cmd.dailyreport', 'cmd.friendlist', 'cmd.console',
  'group.ops.mute', 'group.ops.kick', 'group.ops.clear', 'group.ops.notice',
  'group.ops.essence', 'group.ops.card', 'group.ops.title', 'group.ops.admin', 'group.ops.leave',
])

/** 内置角色：admin（唯一 superuser）、legacy（旧模式兜底）、guest（只读 + 自己的范围 + 共享只读区）。 */
export function builtinRoles() {
  const allBases = [...new Set(PERMISSIONS.map((item) => item.id))]
  return {
    admin: {
      id: 'admin',
      name: '超管',
      description: '唯一 superuser：全部权限（= 主人的个人权限）',
      // 全部权限点，范围用 `*`：任何主体、任何范围都放行。
      permissions: allBases,
      denies: [],
      // 最宽松：'max' 类不限，'min' 类为 0（min 是 0 的行为跟"不限"一致）。
      limits: Object.fromEntries(Object.entries(LIMITS).map(([key, spec]) => [key, spec.direction === 'min' ? 0 : null])),
    },
    /**
     * `legacy`：**只在 `identity.enabled !== true` 时使用的兜底角色**。
     * 旧代码在那种模式下 `#roleOf()` 恒返回 owner（会话能力全开），但命令侧仍是
     * `adminUsers` 白名单说了算 —— 所以这个角色 = admin 减去"命令/管理授权"那一组，
     * 用它来保持两边语义都不变。
     */
    legacy: {
      id: 'legacy',
      name: '旧模式兜底',
      description: 'identity.enabled=false 时的全能力角色：会话能力等同超管，命令授权仍看白名单',
      permissions: allBases.filter((id) => !LEGACY_EXCLUDED.has(basePermission(id))),
      denies: [],
      limits: Object.fromEntries(Object.entries(LIMITS).map(([key, spec]) => [key, spec.direction === 'min' ? 0 : null])),
    },
    guest: {
      id: 'guest',
      name: '访客',
      description: '只读：自己的主体范围 + 共享只读区 + 非管理类命令',
      permissions: [
        // 对话与非管理类命令（管理/创作类不给）
        ...['chat', 'help', 'status', 'health', 'history.search', 'groupinfo', 'members', 'groupfiles',
          'album', 'ocr', 'export', 'mc', 'checkin', 'fortune', 'dice', 'points', 'game', 'vote',
          'todo', 'stats', 'reactions'].map((name) => `cmd.${name}`),
        // 会话内只读工具
        'tool.chat.members', 'tool.chat.history', 'tool.net.search',
        // 文件：自己的范围 + 共享只读区（own 在判定时解析成主体自己的命名空间）
        'tool.fs.read:own', 'tool.fs.read:shared', 'tool.fs.search:own',
        // 人格（不含语料资产：语料要按 id 显式授予）
        'persona.text',
        // 出站：能说话就能回消息
        'qq.write.message',
      ],
      denies: [],
      limits: {},
    },
  }
}

/** 空策略骨架（存储层读不到数据时的兜底：只有内置角色、没有任何分配）。 */
export function emptyPolicy() {
  return {
    defaultRole: 'guest',
    defaultRoleByKind: { user: 'guest', group: 'guest', default: 'guest' },
    roles: builtinRoles(),
    assignments: {},   // subjectId -> [roleId]
    subjectDenies: {}, // subjectId -> [permissionId]
  }
}

/** 把角色授予里的 `own` 范围解析成具体主体 id。 */
export function resolveScope(scope, subjectId) {
  if (scope === 'own' || scope === 'self') return String(subjectId ?? '')
  return scope
}

/** 某主体实际持有的角色（并集；不认识的角色 id 直接丢掉 = fail-closed）。 */
export function rolesFor(policy, subjectId) {
  const roles = policy?.roles ?? {}
  const ids = new Set()
  const wanted = [...(policy?.assignments?.[String(subjectId ?? '')] ?? [])]
  if (wanted.length === 0) {
    // 默认角色按主体类型分（群默认 = 群角色，人默认 = 人角色）；都不配才用 defaultRole。
    const kind = String(subjectId ?? '').split(':')[0]
    wanted.push(policy?.defaultRoleByKind?.[kind] ?? policy?.defaultRole ?? 'guest')
  }
  for (const id of wanted) {
    if (roles[id]) ids.add(id)
  }
  return [...ids]
}

/** 权限点集合：把授予项的范围解析成实际主体（`own` → subjectId）。 */
function resolveGrants(list, subjectId) {
  return (list ?? []).filter((id) => isKnownPermission(id)).map((id) => {
    const { base, scope } = splitPermission(id)
    return scope === '' ? base : `${base}:${resolveScope(scope, subjectId)}`
  })
}

/**
 * 判定一次请求。
 *
 * @param {object} policy   策略（emptyPolicy() 结构；由存储层喂）
 * @param {string} subjectId 主体 id，例如 `user:2493922172` / `group:176628359`
 * @param {object} request  { need?: string[], limits?: string[] }
 * @returns {{allowed:boolean, subjectId:string, roles:string[], missing:string[], denied:string[],
 *            limits:object, reason:string}}
 */
export function evaluate(policy, subjectId, request = {}) {
  const subject = String(subjectId ?? '')
  const need = [...(request.need ?? [])]
  const limitKeys = [...(request.limits ?? [])]
  const roleIds = rolesFor(policy, subject)

  if (roleIds.length === 0) {
    return { allowed: false, subjectId: subject, roles: [], missing: need, denied: [], limits: {}, reason: 'no-role' }
  }

  // allow = 各角色授予的并集；deny = 主体级 deny ∪ 各角色 deny
  const allow = []
  const deny = []
  for (const roleId of roleIds) {
    const role = policy.roles[roleId]
    allow.push(...resolveGrants(role?.permissions, subject))
    deny.push(...resolveGrants(role?.denies, subject))
  }
  deny.push(...resolveGrants(policy?.subjectDenies?.[subject], subject))

  const unknown = need.filter((id) => !isKnownPermission(id))
  const missing = []
  const denied = []
  for (const item of need) {
    if (!isKnownPermission(item)) continue
    const granted = allow.some((have) => permissionSatisfies(have, item))
    if (!granted) missing.push(item)
    // deny 也走同一套匹配：`tool.fs.read:*` 的 deny 覆盖所有范围，`...:u1001` 只覆盖那个范围
    if (deny.some((blocked) => permissionSatisfies(blocked, item))) denied.push(item)
  }

  const allowed = unknown.length === 0 && missing.length === 0 && denied.length === 0
  const reason = unknown.length > 0 ? 'unknown-permission'
    : denied.length > 0 ? 'denied'
      : missing.length > 0 ? 'missing-permission'
        : 'allowed'

  return {
    allowed,
    subjectId: subject,
    roles: roleIds,
    missing,
    denied,
    limits: limitsFor(policy, roleIds, limitKeys),
    reason,
  }
}

/**
 * 限额合并：多身份取最宽松（D-10）。
 * `min` 类取最小值（越小越宽松）、`max` 类取最大值（越大越宽松）；都没配就用注册表默认值。
 */
export function limitsFor(policy, roleIds, keys) {
  const out = {}
  for (const key of keys ?? []) {
    const spec = LIMITS[key]
    if (!spec) continue
    const values = []
    for (const roleId of roleIds ?? []) {
      const value = policy?.roles?.[roleId]?.limits?.[key]
      if (value === undefined) continue
      values.push(value)
    }
    if (values.length === 0) {
      out[key] = spec.default
      continue
    }
    // null = 不限；对 'max' 类 null 就是最宽松，对 'min' 类没法用 null 表达"不限"，
    // 约定该角色显式写 0 表示不限。
    if (values.includes(null) && spec.direction === 'max') {
      out[key] = null
      continue
    }
    const numeric = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
    if (numeric.length === 0) {
      out[key] = spec.default
      continue
    }
    out[key] = spec.direction === 'min' ? Math.min(...numeric) : Math.max(...numeric)
  }
  return out
}

/** 人类可读的判定解释（控制台/排障用）。 */
export function explain(decision) {
  const label = { allowed: '放行', denied: '被 deny 覆盖', 'missing-permission': '缺权限', 'unknown-permission': '未知权限点', 'no-role': '没有可用角色' }
  const parts = [`${label[decision.reason] ?? decision.reason}｜主体 ${decision.subjectId}｜角色 ${decision.roles.join('+') || '无'}`]
  if (decision.missing.length > 0) parts.push(`缺：${decision.missing.join(', ')}`)
  if (decision.denied.length > 0) parts.push(`禁止：${decision.denied.join(', ')}`)
  return parts.join('；')
}

/** 兜底导出，便于测试与调用方少 import 一个文件。 */
export { basePermission }
