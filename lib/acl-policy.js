/**
 * 把"现有配置"翻译成策略对象（PDP 的输入）。
 *
 * 这是**等价迁移**的桥：今天身份散在 `identity.map` / `identity.groupRole(s)` /
 * `identity.defaultRole` / `adminUsers` 四处，翻译关系是
 *
 *   identity.map[qq] = owner        → user:<qq> 持有 admin（owner 是 admin 的历史别名，D-11）
 *   identity.map[qq] = guest        → user:<qq> 持有 guest
 *   adminUsers 里的每个号            → user:<qq> 追加 admin（D-5：白名单就是 admin 身份的分配来源）
 *   identity.groupRoles[gid]        → group:<gid> 持有 admin / guest（整群升级，D-3 既有语义）
 *   identity.groupRole              → 群主体的默认角色
 *   identity.defaultRole            → 人主体的默认角色（私聊）
 *   identity.enabled !== true       → 全员 admin（等价于旧行为"恒返回 owner"）
 *
 * 认不出的角色名一律按 guest（fail-closed，和现在的 roleFor 一致）。
 * 后续接 SQLite 时，这个函数就是"首次初始化"的数据源；运行期策略改从 acl.db 读。
 */
import { emptyPolicy } from './acl.js'

/** 角色名归一化：owner 是 admin 的别名；其余不认识的按 guest（fail-closed）。 */
export function normalizeRoleId(id) {
  const raw = String(id ?? '').trim()
  if (raw === 'admin' || raw === 'owner') return 'admin'
  return 'guest'
}

export function buildPolicyFromConfig(config = {}) {
  const policy = emptyPolicy()
  const raw = (config.identity && typeof config.identity === 'object') ? config.identity : {}
  const enabled = raw.enabled === true

  const add = (subject, roleId) => {
    if (!subject || subject.endsWith(':')) return
    const list = new Set(policy.assignments[subject] ?? [])
    list.add(roleId)
    policy.assignments[subject] = [...list]
  }

  // 1. identity.map：QQ 号 → 角色
  for (const [userId, roleId] of Object.entries(raw.map ?? {})) {
    add(`user:${String(userId).trim()}`, normalizeRoleId(roleId))
  }
  // 2. adminUsers 白名单：追加 admin（不覆盖 map 里已有的角色 —— 多身份取并集）
  for (const id of config.adminUsers ?? []) {
    add(`user:${String(id).trim()}`, 'admin')
  }
  // 3. 按群的角色（整群升级）
  for (const [groupId, roleId] of Object.entries(raw.groupRoles ?? {})) {
    add(`group:${String(groupId).trim()}`, normalizeRoleId(roleId))
  }

  // identity 关掉时：会话能力按旧代码"恒 owner"，但**命令授权**不能跟着放大 ——
  // 用 legacy 角色承担这件事（= admin 减去命令/管理那一组），见 acl.js 的说明。
  policy.defaultRoleByKind = {
    user: enabled ? normalizeRoleId(raw.defaultRole ?? 'guest') : 'legacy',
    group: enabled ? normalizeRoleId(raw.groupRole ?? 'guest') : 'legacy',
    default: 'guest',
  }
  policy.defaultRole = policy.defaultRoleByKind.default
  policy.meta = { source: 'config', identityEnabled: enabled }
  return policy
}
