/**
 * ACL 存储层（SQLite，Node 24 内置 node:sqlite，零依赖）。
 *
 * 分工（见 /home/zfq/dshbot/qq/SPEC-rbac-console.md §5）：
 *   - **权限点词表**以代码为准（lib/permissions.js）；库里那张 `permissions` 只是镜像，
 *     给控制台联表与审计用，冲突永远以代码为准；
 *   - **角色 / 分配 / deny / 限额**是数据，库里说了算；
 *   - 没有库（或 `aclEnabled: false`）时，桥接回落到"从配置翻译"（lib/acl-policy.js），
 *     所以上不上库都不影响启动，回滚也只是删一个文件。
 *
 * 读路径：桥接只调 `loadPolicy()`，结果按 mtime 缓存；写路径：控制台/CLI 调
 * `initFromConfig` / `setRolePermissions` / `setSubjectRoles` …，每次写都进 `acl_audit`。
 */
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { PERMISSIONS, isKnownPermission } from './permissions.js'
import { LIMITS } from './capabilities.js'
import { builtinRoles } from './acl.js'
import { buildPolicyFromConfig, normalizeRoleId } from './acl-policy.js'

export const ACL_SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, name TEXT, description TEXT, builtin INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY, domain TEXT, kind TEXT, label TEXT, group_name TEXT
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL, permission_id TEXT NOT NULL, PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS role_denies (
  role_id TEXT NOT NULL, permission_id TEXT NOT NULL, PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS role_limits (
  role_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (role_id, key)
);
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY, kind TEXT, label TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS subject_roles (
  subject_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (subject_id, role_id)
);
CREATE TABLE IF NOT EXISTS subject_denies (
  subject_id TEXT NOT NULL, permission_id TEXT NOT NULL, PRIMARY KEY (subject_id, permission_id)
);
CREATE TABLE IF NOT EXISTS acl_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, actor TEXT, action TEXT, target TEXT,
  before_json TEXT, after_json TEXT
);
`

/** 打开（必要时创建）库并建表。 */
export function openAclStore(file, { create = true } = {}) {
  const fresh = !existsSync(file)
  if (fresh && create !== true) return null
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(ACL_SCHEMA_VERSION))
  return wrap(db, file)
}

function wrap(db, file) {
  const store = {
    file,
    db,

    close() { try { db.close() } catch { /* 忽略 */ } },

    /** 权限点镜像：以代码为准，启动/写入时同步一次。 */
    syncPermissions() {
      const stmt = db.prepare('INSERT OR REPLACE INTO permissions(id, domain, kind, label, group_name) VALUES (?, ?, ?, ?, ?)')
      for (const item of PERMISSIONS) {
        stmt.run(item.id, String(item.id).split('.')[0], item.kind ?? '', item.label ?? '', item.group ?? '')
      }
      return PERMISSIONS.length
    },

    /** 内置角色（admin / legacy / guest）写进库：只在缺失或显式 --force 时覆盖。 */
    seedBuiltinRoles({ force = false } = {}) {
      const roles = builtinRoles()
      const insert = db.prepare('INSERT OR REPLACE INTO roles(id, name, description, builtin, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      const delPerm = db.prepare('DELETE FROM role_permissions WHERE role_id = ?')
      const delDeny = db.prepare('DELETE FROM role_denies WHERE role_id = ?')
      const delLimit = db.prepare('DELETE FROM role_limits WHERE role_id = ?')
      const insPerm = db.prepare('INSERT OR REPLACE INTO role_permissions(role_id, permission_id) VALUES (?, ?)')
      const insDeny = db.prepare('INSERT OR REPLACE INTO role_denies(role_id, permission_id) VALUES (?, ?)')
      const insLimit = db.prepare('INSERT OR REPLACE INTO role_limits(role_id, key, value) VALUES (?, ?, ?)')
      const now = Date.now()
      let seeded = 0
      for (const role of Object.values(roles)) {
        const exists = db.prepare('SELECT id FROM roles WHERE id = ?').get(role.id)
        if (exists && force !== true) continue
        insert.run(role.id, role.name ?? role.id, role.description ?? '', now, now)
        delPerm.run(role.id); delDeny.run(role.id); delLimit.run(role.id)
        for (const perm of role.permissions ?? []) insPerm.run(role.id, perm)
        for (const perm of role.denies ?? []) insDeny.run(role.id, perm)
        for (const [key, value] of Object.entries(role.limits ?? {})) {
          if (value === undefined) continue
          insLimit.run(role.id, key, value === null ? 'null' : String(value))
        }
        seeded++
      }
      return seeded
    },

    /** 从现有配置（identity / adminUsers）导入分配，等价迁移用。 */
    importAssignmentsFromConfig(config = {}) {
      const source = buildPolicyFromConfig(config)
      const insSubject = db.prepare('INSERT OR REPLACE INTO subjects(id, kind, label, note) VALUES (?, ?, ?, ?)')
      const insRole = db.prepare('INSERT OR REPLACE INTO subject_roles(subject_id, role_id) VALUES (?, ?)')
      const kindOf = (id) => String(id).split(':')[0]
      let n = 0
      for (const [subject, roleIds] of Object.entries(source.assignments ?? {})) {
        insSubject.run(subject, kindOf(subject), '', 'imported from config')
        for (const roleId of roleIds) { insRole.run(subject, roleId); n++ }
      }
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('default_role_user', source.defaultRoleByKind.user)
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('default_role_group', source.defaultRoleByKind.group)
      return n
    },

    /** 读成策略对象（PDP 的输入）。库损坏/缺表时抛错，由调用方回落到配置。 */
    loadPolicy() {
      const roleRows = db.prepare('SELECT id, name, description FROM roles').all()
      const roles = {}
      const permRows = db.prepare('SELECT role_id, permission_id FROM role_permissions').all()
      const denyRows = db.prepare('SELECT role_id, permission_id FROM role_denies').all()
      const limitRows = db.prepare('SELECT role_id, key, value FROM role_limits').all()
      for (const row of roleRows) roles[row.id] = { id: row.id, name: row.name, description: row.description, permissions: [], denies: [], limits: {} }
      for (const row of permRows) {
        if (!roles[row.role_id]) continue
        if (!isKnownPermission(row.permission_id)) continue   // 词表里没有的授权一律忽略（fail-closed）
        roles[row.role_id].permissions.push(row.permission_id)
      }
      for (const row of denyRows) {
        if (!roles[row.role_id]) continue
        if (!isKnownPermission(row.permission_id)) continue
        roles[row.role_id].denies.push(row.permission_id)
      }
      for (const row of limitRows) {
        if (!roles[row.role_id]) continue
        if (!LIMITS[row.key]) continue
        roles[row.role_id].limits[row.key] = row.value === 'null' ? null : Number(row.value)
      }
      const assignments = {}
      for (const row of db.prepare('SELECT subject_id, role_id FROM subject_roles').all()) {
        if (!roles[row.role_id]) continue
        assignments[row.subject_id] = [...(assignments[row.subject_id] ?? []), row.role_id]
      }
      const subjectDenies = {}
      for (const row of db.prepare('SELECT subject_id, permission_id FROM subject_denies').all()) {
        if (!isKnownPermission(row.permission_id)) continue
        subjectDenies[row.subject_id] = [...(subjectDenies[row.subject_id] ?? []), row.permission_id]
      }
      const metaOf = (key, fallback) => {
        const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
        return row?.value ?? fallback
      }
      return {
        roles,
        assignments,
        subjectDenies,
        defaultRoleByKind: {
          user: metaOf('default_role_user', 'guest'),
          group: metaOf('default_role_group', 'guest'),
          default: 'guest',
        },
        defaultRole: 'guest',
        meta: { source: 'sqlite', file: store.file },
      }
    },

    // ── 写入（控制台/CLI 用；每次写都记审计） ──────────────────────────────
    setRolePermissions(roleId, permissionIds, { actor = 'cli' } = {}) {
      const before = db.prepare('SELECT permission_id FROM role_permissions WHERE role_id = ?').all().map((r) => r.permission_id)
      const tx = db.prepare('DELETE FROM role_permissions WHERE role_id = ?')
      const ins = db.prepare('INSERT OR REPLACE INTO role_permissions(role_id, permission_id) VALUES (?, ?)')
      tx.run(roleId)
      const kept = []
      for (const id of permissionIds ?? []) {
        if (!isKnownPermission(id)) continue
        ins.run(roleId, id); kept.push(id)
      }
      this.audit({ actor, action: 'set-role-permissions', target: roleId, before, after: kept })
      return kept
    },

    setRoleDenies(roleId, permissionIds, { actor = 'cli' } = {}) {
      const before = db.prepare('SELECT permission_id FROM role_denies WHERE role_id = ?').all().map((r) => r.permission_id)
      db.prepare('DELETE FROM role_denies WHERE role_id = ?').run(roleId)
      const ins = db.prepare('INSERT OR REPLACE INTO role_denies(role_id, permission_id) VALUES (?, ?)')
      const kept = []
      for (const id of permissionIds ?? []) {
        if (!isKnownPermission(id)) continue
        ins.run(roleId, id); kept.push(id)
      }
      this.audit({ actor, action: 'set-role-denies', target: roleId, before, after: kept })
      return kept
    },

    setSubjectRoles(subjectId, roleIds, { actor = 'cli' } = {}) {
      const before = db.prepare('SELECT role_id FROM subject_roles WHERE subject_id = ?').all().map((r) => r.role_id)
      db.prepare('INSERT OR REPLACE INTO subjects(id, kind, label, note) VALUES (?, ?, ?, ?)')
        .run(subjectId, String(subjectId).split(':')[0], '', '')
      db.prepare('DELETE FROM subject_roles WHERE subject_id = ?').run(subjectId)
      const ins = db.prepare('INSERT OR REPLACE INTO subject_roles(subject_id, role_id) VALUES (?, ?)')
      const known = new Set(db.prepare('SELECT id FROM roles').all().map((r) => r.id))
      const kept = []
      for (const roleId of roleIds ?? []) {
        const normalized = normalizeRoleId(roleId)
        if (!known.has(normalized)) continue
        ins.run(subjectId, normalized); kept.push(normalized)
      }
      this.audit({ actor, action: 'set-subject-roles', target: subjectId, before, after: kept })
      return kept
    },

    setSubjectDenies(subjectId, permissionIds, { actor = 'cli' } = {}) {
      const before = db.prepare('SELECT permission_id FROM subject_denies WHERE subject_id = ?').all().map((r) => r.permission_id)
      db.prepare('DELETE FROM subject_denies WHERE subject_id = ?').run(subjectId)
      const ins = db.prepare('INSERT OR REPLACE INTO subject_denies(subject_id, permission_id) VALUES (?, ?)')
      const kept = []
      for (const id of permissionIds ?? []) {
        if (!isKnownPermission(id)) continue
        ins.run(subjectId, id); kept.push(id)
      }
      this.audit({ actor, action: 'set-subject-denies', target: subjectId, before, after: kept })
      return kept
    },

    audit({ actor = '', action = '', target = '', before = null, after = null } = {}) {
      db.prepare('INSERT INTO acl_audit(at, actor, action, target, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(Date.now(), String(actor), String(action), String(target),
          before === null ? '' : JSON.stringify(before), after === null ? '' : JSON.stringify(after))
    },

    auditTail(limit = 50) {
      return db.prepare('SELECT at, actor, action, target, before_json, after_json FROM acl_audit ORDER BY id DESC LIMIT ?').all(Number(limit) || 50)
    },

    /** 导出成 JSON 快照（便于 diff / 手改回填 / 备份）。 */
    exportJson() {
      const policy = this.loadPolicy()
      return {
        schemaVersion: ACL_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        roles: policy.roles,
        assignments: policy.assignments,
        subjectDenies: policy.subjectDenies,
        defaultRoleByKind: policy.defaultRoleByKind,
      }
    },
  }
  return store
}

/**
 * 桥接侧的读取入口：文件在就按 mtime 缓存加载；解析失败回落配置（fail-safe but loud）。
 * 返回 `{ policy, source }`。
 */
export function createAclReader({ file, logger = null, fallback = null, cacheMs = 5000 } = {}) {
  let cached = null
  return function readPolicy() {
    try {
      if (!file || !existsSync(file)) return { policy: typeof fallback === 'function' ? fallback() : null, source: 'config' }
      const mtime = statSync(file).mtimeMs
      if (cached && cached.mtime === mtime && Date.now() - cached.at < cacheMs) {
        return { policy: cached.policy, source: 'sqlite-cache' }
      }
      const store = openAclStore(file, { create: false })
      try {
        const policy = store.loadPolicy()
        cached = { mtime, at: Date.now(), policy }
        return { policy, source: 'sqlite' }
      } finally {
        store?.close()
      }
    } catch (error) {
      logger?.warn?.(`[权限模型] 读取 ${file} 失败，回落到配置：${error?.message ?? error}`)
      return { policy: typeof fallback === 'function' ? fallback() : null, source: 'config-fallback' }
    }
  }
}
