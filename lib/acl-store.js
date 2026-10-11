/**
 * ACL 存储层（SQLite，Node 24 内置 node:sqlite，零依赖）。
 *
 * 分工（见仓库 docs/ 的权限控制台规格 §5）：
 *   - **权限点词表**以代码为准（lib/permissions.js）；库里那张 `permissions` 只是镜像，
 *     给控制台联表与审计用，冲突永远以代码为准；
 *   - **角色 / 分配 / deny / 限额**是数据，库里说了算；
 *   - 没有库（或 `aclEnabled: false`）时，桥接回落到"从配置翻译"（lib/acl-policy.js），
 *     所以上不上库都不影响启动，回滚也只是删一个文件。
 *
 * 读路径：桥接只调 `loadPolicy()`，结果按 mtime 缓存；写路径：控制台/CLI 调
 * `initFromConfig` / `setRolePermissions` / `setSubjectRoles` …，每次写都进 `acl_audit`。
 */
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PERMISSIONS, isKnownPermission } from './permissions.js'
import { LIMITS } from './capabilities.js'
import { builtinRoles } from './acl.js'
import { buildPolicyFromConfig } from './acl-policy.js'

export const ACL_SCHEMA_VERSION = 2

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
-- v2 新增（SPEC-rbac-console.md §5.2 / §6）：
--   resources / resource_grants —— 可授权资源（外部服务、目录、共享只读区）
--   corpora / corpus_bindings   —— 语料资产与其主体绑定
--   sessions                    —— 主体 → 会话 → 生效能力面快照（"哪些会话还在用旧能力面"）
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY, kind TEXT, uri TEXT, label TEXT, note TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS resource_grants (
  role_id TEXT NOT NULL, resource_id TEXT NOT NULL, actions TEXT,
  PRIMARY KEY (role_id, resource_id)
);
CREATE TABLE IF NOT EXISTS corpora (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, description TEXT, payload_ref TEXT,
  version INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS corpus_bindings (
  subject_id TEXT NOT NULL, corpus_id TEXT NOT NULL, is_default INTEGER DEFAULT 0,
  PRIMARY KEY (subject_id, corpus_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, roles_snapshot TEXT,
  surface_json TEXT, created_at INTEGER, last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_subject ON sessions(subject_id);
`

/**
 * 写前备份（SPEC 要求）：把库拷成 `<file>.bak-<时间戳>`，只保留最近 `keep` 份。
 * 拷之前先做一次 WAL checkpoint，否则 WAL 里刚提交的事务不在主文件里，备份会少数据。
 * 备份失败**不阻断**写操作（返回空串并把原因交给调用方），但会记进审计。
 */
export function backupAclFile(db, file, { keep = 10 } = {}) {
  try {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* checkpoint 失败也继续拷 */ }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${file}.bak-${stamp}`
    copyFileSync(file, target)
    const dir = dirname(file)
    const base = `${basename(file)}.bak-`
    const old = readdirSync(dir).filter((name) => name.startsWith(base)).sort()
    while (old.length > keep) {
      const victim = old.shift()
      try { unlinkSync(join(dir, victim)) } catch { /* 删不掉就算了 */ }
    }
    return target
  } catch {
    return ''
  }
}

/**
 * 角色 id 归一化：**先认库里真实存在的角色**（自定义角色如 `gq` 必须原样保留），
 * 认不出才走历史别名（`owner` → `admin`），再认不出返回 ''（调用方 fail-closed 丢掉）。
 *
 * 踩过的坑：这里原来直接用 `normalizeRoleId()` —— 那个函数的语义是"把 profile 配置里的
 * owner/guest 翻译成角色"，认不出的一律给 guest。于是控制台里给主体挂自定义角色 `gq`，
 * 一保存就被改写成 guest（审计里看得明明白白），界面上勾的和库里存的不是一回事。
 */
export function canonicalRoleId(id, knownIds) {
  const raw = String(id ?? '').trim()
  if (raw === '') return ''
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? [])
  if (known.has(raw)) return raw
  if (raw === 'owner' && known.has('admin')) return 'admin'
  return ''
}

function safeParse(text, fallback) {
  try { return text ? JSON.parse(text) : fallback } catch { return fallback }
}

/** 打开（必要时创建）库并建表。`backup` 控制写前备份（测试里可关）。 */
export function openAclStore(file, { create = true, backup = true } = {}) {
  const fresh = !existsSync(file)
  if (fresh && create !== true) return null
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(ACL_SCHEMA_VERSION))
  return wrap(db, file, { backup })
}

function wrap(db, file, { backup = true } = {}) {
  const store = {
    file,
    db,

    close() { try { db.close() } catch { /* 忽略 */ } },

    /** 写前备份（只有"配置类"写操作调用；运行期快照不调，否则一天几百份）。 */
    backupNow() {
      if (backup !== true) return ''
      return backupAclFile(db, file)
    },

    /** 显式事务：回调抛错即回滚。 */
    tx(fn) {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* 回滚失败也把原错误抛出去 */ }
        throw error
      }
    },

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
      // ── v2：资源与语料（一起进策略快照，桥接侧一次读取就能拿到） ──
      const resources = {}
      for (const row of db.prepare('SELECT id, kind, uri, label, note FROM resources').all()) {
        resources[row.id] = { id: row.id, kind: row.kind, uri: row.uri, label: row.label, note: row.note, grants: {} }
      }
      for (const row of db.prepare('SELECT role_id, resource_id, actions FROM resource_grants').all()) {
        const resource = resources[row.resource_id]
        if (!resource) continue
        resource.grants[row.role_id] = String(row.actions ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      }
      const corpora = {}
      for (const row of db.prepare('SELECT id, name, kind, description, payload_ref, version, enabled FROM corpora').all()) {
        corpora[row.id] = {
          id: row.id, name: row.name, kind: row.kind, description: row.description,
          payloadRef: row.payload_ref, version: Number(row.version) || 1, enabled: Number(row.enabled) !== 0,
        }
      }
      const corpusBindings = {}
      for (const row of db.prepare('SELECT subject_id, corpus_id, is_default FROM corpus_bindings').all()) {
        if (!corpora[row.corpus_id]) continue
        corpusBindings[row.subject_id] = [...(corpusBindings[row.subject_id] ?? []), row.corpus_id]
      }
      const metaOf = (key, fallback) => {
        const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
        return row?.value ?? fallback
      }
      return {
        roles,
        assignments,
        subjectDenies,
        resources,
        corpora,
        corpusBindings,
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
      this.backupNow()
      const kept = this.tx(() => {
        db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId)
        const ins = db.prepare('INSERT OR REPLACE INTO role_permissions(role_id, permission_id) VALUES (?, ?)')
        const out = []
        for (const id of permissionIds ?? []) {
          if (!isKnownPermission(id)) continue
          ins.run(roleId, id); out.push(id)
        }
        return out
      })
      this.audit({ actor, action: 'set-role-permissions', target: roleId, before, after: kept })
      return kept
    },

    setRoleDenies(roleId, permissionIds, { actor = 'cli' } = {}) {
      const before = db.prepare('SELECT permission_id FROM role_denies WHERE role_id = ?').all().map((r) => r.permission_id)
      this.backupNow()
      const kept = this.tx(() => {
        db.prepare('DELETE FROM role_denies WHERE role_id = ?').run(roleId)
        const ins = db.prepare('INSERT OR REPLACE INTO role_denies(role_id, permission_id) VALUES (?, ?)')
        const out = []
        for (const id of permissionIds ?? []) {
          if (!isKnownPermission(id)) continue
          ins.run(roleId, id); out.push(id)
        }
        return out
      })
      this.audit({ actor, action: 'set-role-denies', target: roleId, before, after: kept })
      return kept
    },

    setSubjectRoles(subjectId, roleIds, { actor = 'cli' } = {}) {
      const before = db.prepare('SELECT role_id FROM subject_roles WHERE subject_id = ?').all().map((r) => r.role_id)
      this.backupNow()
      const kept = this.tx(() => {
        db.prepare('INSERT OR REPLACE INTO subjects(id, kind, label, note) VALUES (?, ?, ?, ?)')
          .run(subjectId, String(subjectId).split(':')[0], '', '')
        db.prepare('DELETE FROM subject_roles WHERE subject_id = ?').run(subjectId)
        const ins = db.prepare('INSERT OR REPLACE INTO subject_roles(subject_id, role_id) VALUES (?, ?)')
        const known = new Set(db.prepare('SELECT id FROM roles').all().map((r) => r.id))
        const out = []
        for (const roleId of roleIds ?? []) {
          // 自定义角色原样挂；只认不出时才回落到历史别名，最后丢掉（fail-closed）
          const canonical = canonicalRoleId(roleId, known)
          if (canonical === '') continue
          ins.run(subjectId, canonical); out.push(canonical)
        }
        return out
      })
      this.audit({ actor, action: 'set-subject-roles', target: subjectId, before, after: kept })
      return kept
    },

    setSubjectDenies(subjectId, permissionIds, { actor = 'cli' } = {}) {
      const before = db.prepare('SELECT permission_id FROM subject_denies WHERE subject_id = ?').all().map((r) => r.permission_id)
      this.backupNow()
      const kept = this.tx(() => {
        db.prepare('DELETE FROM subject_denies WHERE subject_id = ?').run(subjectId)
        const ins = db.prepare('INSERT OR REPLACE INTO subject_denies(subject_id, permission_id) VALUES (?, ?)')
        const out = []
        for (const id of permissionIds ?? []) {
          if (!isKnownPermission(id)) continue
          ins.run(subjectId, id); out.push(id)
        }
        return out
      })
      this.audit({ actor, action: 'set-subject-denies', target: subjectId, before, after: kept })
      return kept
    },

    // ── v2：资源与范围 ────────────────────────────────────────────────
    upsertResource({ id, kind = 'dir', uri = '', label = '', note = '' } = {}, { actor = 'cli' } = {}) {
      const key = String(id ?? '').trim()
      if (key === '') throw new Error('资源 id 不能为空')
      const before = db.prepare('SELECT id, kind, uri, label, note FROM resources WHERE id = ?').get(key) ?? null
      this.backupNow()
      this.tx(() => {
        db.prepare('INSERT INTO resources(id, kind, uri, label, note, created_at) VALUES (?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, uri=excluded.uri, label=excluded.label, note=excluded.note')
          .run(key, String(kind), String(uri), String(label), String(note), Date.now())
      })
      const after = db.prepare('SELECT id, kind, uri, label, note FROM resources WHERE id = ?').get(key)
      this.audit({ actor, action: 'resource-upsert', target: key, before, after })
      return after
    },

    deleteResource(id, { actor = 'cli' } = {}) {
      const key = String(id ?? '')
      const before = db.prepare('SELECT id, kind, uri FROM resources WHERE id = ?').get(key) ?? null
      if (!before) return false
      this.backupNow()
      this.tx(() => {
        db.prepare('DELETE FROM resources WHERE id = ?').run(key)
        db.prepare('DELETE FROM resource_grants WHERE resource_id = ?').run(key)
      })
      this.audit({ actor, action: 'resource-delete', target: key, before })
      return true
    },

    /** 覆盖某个角色的资源授权。`entries` = [{ resourceId, actions: ['read','write'] }] */
    setResourceGrants(roleId, entries, { actor = 'cli' } = {}) {
      const role = String(roleId ?? '')
      const before = db.prepare('SELECT resource_id, actions FROM resource_grants WHERE role_id = ?').all()
      if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(role)) throw new Error(`角色不存在：${role}`)
      this.backupNow()
      const kept = this.tx(() => {
        db.prepare('DELETE FROM resource_grants WHERE role_id = ?').run(role)
        const ins = db.prepare('INSERT INTO resource_grants(role_id, resource_id, actions) VALUES (?, ?, ?)')
        const out = []
        for (const entry of entries ?? []) {
          const resourceId = String(entry?.resourceId ?? '').trim()
          if (resourceId === '') continue
          if (!db.prepare('SELECT id FROM resources WHERE id = ?').get(resourceId)) continue   // fail-closed
          const actions = (Array.isArray(entry?.actions) ? entry.actions : String(entry?.actions ?? '').split(','))
            .map((x) => String(x).trim()).filter((x) => ['read', 'write', 'exec'].includes(x))
          ins.run(role, resourceId, actions.join(','))
          out.push({ resourceId, actions })
        }
        return out
      })
      this.audit({ actor, action: 'set-resource-grants', target: role, before, after: kept })
      return kept
    },

    // ── v2：语料资产 ──────────────────────────────────────────────────
    upsertCorpus({ id, name = '', kind = 'files', description = '', payloadRef = '', version = 1, enabled = true } = {}, { actor = 'cli' } = {}) {
      const key = String(id ?? '').trim()
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(key)) throw new Error('语料 id 只能用小写字母/数字/下划线/短横线')
      const before = db.prepare('SELECT * FROM corpora WHERE id = ?').get(key) ?? null
      this.backupNow()
      const now = Date.now()
      this.tx(() => {
        db.prepare('INSERT INTO corpora(id, name, kind, description, payload_ref, version, enabled, created_at, updated_at) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, description=excluded.description, '
          + 'payload_ref=excluded.payload_ref, version=excluded.version, enabled=excluded.enabled, updated_at=excluded.updated_at')
          .run(key, String(name || key), String(kind), String(description), String(payloadRef),
            Number(version) || 1, enabled === false || enabled === 0 ? 0 : 1, now, now)
      })
      this.audit({ actor, action: 'corpus-upsert', target: key, before, after: { name, kind, payloadRef, enabled } })
      return db.prepare('SELECT * FROM corpora WHERE id = ?').get(key)
    },

    deleteCorpus(id, { actor = 'cli' } = {}) {
      const key = String(id ?? '')
      const before = db.prepare('SELECT * FROM corpora WHERE id = ?').get(key) ?? null
      if (!before) return false
      this.backupNow()
      this.tx(() => {
        db.prepare('DELETE FROM corpora WHERE id = ?').run(key)
        db.prepare('DELETE FROM corpus_bindings WHERE corpus_id = ?').run(key)
      })
      this.audit({ actor, action: 'corpus-delete', target: key, before: { id: key, name: before.name } })
      return true
    },

    /** 覆盖某个主体的语料绑定（要能被角色白名单再过滤一次）。 */
    setCorpusBindings(subjectId, corpusIds, { actor = 'cli' } = {}) {
      const subject = String(subjectId ?? '').trim()
      const before = db.prepare('SELECT corpus_id FROM corpus_bindings WHERE subject_id = ?').all().map((r) => r.corpus_id)
      this.backupNow()
      const kept = this.tx(() => {
        db.prepare('INSERT OR REPLACE INTO subjects(id, kind, label, note) VALUES (?, ?, ?, ?)')
          .run(subject, subject.split(':')[0], '', '')
        db.prepare('DELETE FROM corpus_bindings WHERE subject_id = ?').run(subject)
        const ins = db.prepare('INSERT OR REPLACE INTO corpus_bindings(subject_id, corpus_id, is_default) VALUES (?, ?, 0)')
        const out = []
        for (const raw of corpusIds ?? []) {
          const id = String(raw).trim()
          if (!db.prepare('SELECT id FROM corpora WHERE id = ?').get(id)) continue
          ins.run(subject, id); out.push(id)
        }
        return out
      })
      this.audit({ actor, action: 'set-corpus-bindings', target: subject, before, after: kept })
      return kept
    },

    // ── v2：生效快照（"哪些会话还在用旧能力面"） ─────────────────────
    recordSession({ subjectId, sessionId, roles = [], surface = {}, at = Date.now() } = {}) {
      const sid = String(sessionId ?? '')
      if (sid === '') return false
      const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sid)
      db.prepare('INSERT INTO sessions(session_id, subject_id, roles_snapshot, surface_json, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(session_id) DO UPDATE SET subject_id=excluded.subject_id, roles_snapshot=excluded.roles_snapshot, '
        + 'surface_json=excluded.surface_json, last_seen=excluded.last_seen')
        .run(sid, String(subjectId ?? ''), JSON.stringify(roles ?? []), JSON.stringify(surface ?? {}), at, at)
      return existing === undefined
    },

    listSessions(limit = 200) {
      return db.prepare('SELECT session_id, subject_id, roles_snapshot, surface_json, created_at, last_seen '
        + 'FROM sessions ORDER BY last_seen DESC LIMIT ?').all(Number(limit) || 200).map((row) => ({
        sessionId: row.session_id, subjectId: row.subject_id,
        roles: safeParse(row.roles_snapshot, []), surface: safeParse(row.surface_json, {}),
        createdAt: Number(row.created_at), lastSeen: Number(row.last_seen),
      }))
    },

    pruneSessions(before = Date.now() - 30 * 24 * 3600 * 1000) {
      const info = db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(Number(before))
      return Number(info?.changes ?? 0)
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
        resources: policy.resources ?? {},
        corpora: policy.corpora ?? {},
        corpusBindings: policy.corpusBindings ?? {},
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
