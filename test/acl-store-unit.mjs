/**
 * ACL 存储层（SQLite）验收。
 *
 * 覆盖：
 *   - 建库 / 建表 / 内置角色落库 / 权限点镜像；
 *   - 从现有配置导入分配（等价迁移的入口）；
 *   - 角色权限、角色 deny、主体分配、主体 deny 的写入 + 审计留痕；
 *   - fail-closed：库里出现词表没有的权限点一律忽略；
 *   - 桥接读取：有库用库、没库回落配置、库损坏回落并告警、库变更按 mtime 重新加载；
 *   - 端到端：在库里给基础角色补上 shell 权限 → 该群的会话真的挂上能跑 shell 的 preset。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'
import { openAclStore, createAclReader } from '../lib/acl-store.js'
import { buildPolicyFromConfig } from '../lib/acl-policy.js'
import { evaluate } from '../lib/acl.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-aclstore-'))
const dbFile = join(root, 'config', 'acl.db')
mkdirSync(join(root, 'config'), { recursive: true })

// ===== 1. 建库与内置角色 =====
const store = openAclStore(dbFile)
store.syncPermissions()
const seeded = store.seedBuiltinRoles()
check('内置角色落库（admin / legacy / guest）', seeded >= 3, `seeded=${seeded}`)
const p1 = store.loadPolicy()
check('从库读出的策略含 admin / legacy / guest',
  ['admin', 'legacy', 'guest'].every((id) => Boolean(p1.roles[id])), Object.keys(p1.roles).join(','))
check('admin 角色在库里是全部权限点',
  p1.roles.admin.permissions.length >= 60, String(p1.roles.admin.permissions.length))
check('guest 角色在库里没有踢人权限',
  !p1.roles.guest.permissions.includes('group.ops.kick'))
check('guest 角色在库里有自己范围的读权限',
  p1.roles.guest.permissions.includes('tool.fs.read:own'))
check('从库读出的角色可以直接喂 PDP：guest 不能踢人',
  evaluate(p1, 'group:2001', { need: ['group.ops.kick'] }).allowed === false)
check('从库读出的角色可以直接喂 PDP：admin 角色本身含 shell 权限',
  evaluate({ ...p1, assignments: { 'user:1001': ['admin'] } }, 'user:1001', { need: ['tool.shell'] }).allowed === true)

// ===== 2. 从配置导入分配 =====
const imported = store.importAssignmentsFromConfig({
  identity: { enabled: true, map: { 1001: 'owner' }, defaultRole: 'guest', groupRole: 'guest' },
  adminUsers: [1002],
})
check('导入分配：map 的 owner + adminUsers 都落库', imported >= 2, `rows=${imported}`)
const p2 = store.loadPolicy()
check('导入后 user:1001 是 admin', (p2.assignments['user:1001'] ?? []).includes('admin'))
check('导入后 user:1002 是 admin', (p2.assignments['user:1002'] ?? []).includes('admin'))
check('导入后默认角色写进 meta', p2.defaultRoleByKind.user === 'guest' && p2.defaultRoleByKind.group === 'guest')

// ===== 3. 写入 + 审计 =====
store.setSubjectRoles('group:2001', ['owner'])
check('主体分配写入生效', (store.loadPolicy().assignments['group:2001'] ?? []).includes('admin'))
store.setSubjectDenies('user:1001', ['tool.shell'])
check('主体 deny 写入生效', (store.loadPolicy().subjectDenies['user:1001'] ?? []).includes('tool.shell'))
check('主体 deny 在 PDP 里压过 admin 身份',
  evaluate(store.loadPolicy(), 'user:1001', { need: ['tool.shell'] }).allowed === false)
const newPerms = store.setRolePermissions('guest', [...p1.roles.guest.permissions, 'tool.net.search'])
check('角色权限写入返回保留下来的列表', newPerms.includes('tool.net.search'))
const audit = store.auditTail(10)
check('每次写入都留了审计记录', audit.length >= 3, `rows=${audit.length}`)
check('审计含动作与目标', audit.some((r) => r.action === 'set-subject-roles' && r.target === 'group:2001'))

// ===== 4. fail-closed：词表外的权限点一律忽略 =====
store.db.prepare('INSERT INTO role_permissions(role_id, permission_id) VALUES (?, ?)').run('guest', 'cmd.not-a-real-permission')
const p3 = store.loadPolicy()
check('库里的未知权限点被忽略（不会因此放权）',
  !p3.roles.guest.permissions.includes('cmd.not-a-real-permission'))

// ===== 5. 导出快照 =====
const snapshot = store.exportJson()
check('导出快照含角色/分配/deny', Boolean(snapshot.roles.admin && snapshot.assignments && snapshot.subjectDenies))
store.close()

// ===== 6. 读取器：有库用库、无库回落、损坏回落 =====
const missingReader = createAclReader({ file: join(root, 'nope.db'), fallback: () => ({ marker: 'config' }) })
check('库文件不存在 → 回落配置', missingReader().source === 'config' && missingReader().policy.marker === 'config')
const reader = createAclReader({ file: dbFile, fallback: () => buildPolicyFromConfig({ identity: { enabled: true } }) })
check('库存在 → 用库', reader().source === 'sqlite' && Boolean(reader().policy.roles.admin))
const before = reader().policy.roles.guest.permissions.length
const store2 = openAclStore(dbFile, { create: false })
store2.setRolePermissions('guest', [...store2.loadPolicy().roles.guest.permissions, 'cmd.image'])
store2.close()
// mtime 分辨率保护：显式改一下时间戳，保证读取器认为文件变了
const future = new Date(Date.now() + 2000)
utimesSync(dbFile, future, future)
const after = reader().policy.roles.guest.permissions.length
check('库变更后按 mtime 重新加载（新权限可见）', after > before, `${before} → ${after}`)
const broken = join(root, 'broken.db')
writeFileSync(broken, 'not a sqlite file at all')
const brokenReader = createAclReader({ file: broken, fallback: () => ({ marker: 'config' }), logger: { warn: () => {} } })
check('库损坏 → 回落配置（不崩）', brokenReader().policy.marker === 'config')

// ===== 7. 端到端：库里给基础角色补 shell → 该群会话挂上能跑 shell 的 preset =====
const store3 = openAclStore(dbFile, { create: false })
store3.setSubjectRoles('group:2001', ['guest'])
const guestPerms = store3.loadPolicy().roles.guest.permissions
store3.setRolePermissions('guest', [...guestPerms, 'tool.shell', 'tool.fs.write:*'])
store3.close()

class MockServer extends EventEmitter {
  constructor() { super(); this.sent = []; this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} } }
  sendSegments(_b, messageType, targetId, segments) { this.sent.push({ messageType, targetId, segments }); return Promise.resolve({ message_id: `m${this.sent.length}` }) }
  sendText(_b, messageType, targetId, text) { return this.sendSegments(_b, messageType, targetId, [{ type: 'text', data: { text } }]) }
  currentSocket() { return this.socket }
}
function makeCtx() {
  const handlers = new Map()
  const built = []
  const emit = (sessionId, text) => { for (const h of handlers.get('session/event') ?? []) h({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }) }
  const build = async (sessionId, options) => {
    const record = { sessionId: String(sessionId), meta: options.meta ?? {}, restrict: [], tools: [] }
    const agentCtx = {
      systemPrompt: { section: () => {} },
      tools: { register: (t) => record.tools.push(t?.name ?? ''), restrict: (s) => record.restrict.push(s), get: () => undefined },
    }
    if (options.setup) await options.setup(agentCtx)
    const agent = { id: String(sessionId), status: 'idle', followup: (m) => { setTimeout(() => emit(String(sessionId), '（回复）'), 5) }, cancel: () => {} }
    built.push(record)
    return { agent, dispose: async () => {} }
  }
  const ctx = {
    on: (e, h) => { const l = handlers.get(e) ?? []; l.push(h); handlers.set(e, l); return () => {} },
    get: () => undefined,
    agents: { create: async (o) => build(o.sessionId, o), resume: async (o) => build(o.resumeSessionId, o) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return { ctx, built }
}

const stateDir = join(root, 'state')
mkdirSync(stateDir, { recursive: true })
const config = Config({
  cwd: stateDir,
  dataRoot: root,
  aclDbFile: dbFile,
  allowGroups: [2001],
  allowUsers: [1001, 1003],
  botQq: 999,
  identity: { enabled: true, map: { 1001: 'owner' }, defaultRole: 'guest', groupRole: 'guest' },
  sessionResumeEnabled: true,
  historyArchiveEnabled: false,
  memoryEnabled: false,
})
const server = new MockServer()
const { ctx, built } = makeCtx()
const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
bridge.start()
server.emit('message', {
  bot: server.socket, userId: 1003, messageType: 'group', groupId: 2001, text: '你好', atMe: true, ats: [999],
  reply: null, records: [], images: [], files: [], messageId: 'm1', senderName: 'tester', raw: { message: [] },
})
await new Promise((r) => setTimeout(r, 400))
const session = built[built.length - 1]
check('端到端：库给了 shell 权限 → 群会话挂上 qq-coding', session?.meta?.agentPreset === 'qq-coding', String(session?.meta?.agentPreset))
check('端到端：库里给了写权限 → 白名单里出现 write/edit',
  (session?.restrict?.[0]?.allow ?? []).includes('write') && (session?.restrict?.[0]?.allow ?? []).includes('edit'),
  JSON.stringify(session?.restrict?.[0] ?? null))
check('端到端：库里没给的 ECS 工具仍被挡', !(session?.restrict?.[0]?.allow ?? []).includes('ecs_exec'))
bridge.stop()

// ===== 自定义角色：挂到主体上必须原样保存（回归：曾被 normalizeRoleId 改写成 guest）=====
const st3 = openAclStore(dbFile, { create: false })
st3.db.prepare('INSERT OR REPLACE INTO roles(id, name, description, builtin, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run('gq', '群友', '自定义角色', Date.now(), Date.now())
st3.setRolePermissions('gq', ['cmd.chat', 'cmd.image', 'tool.image.generate'], { actor: 'unit' })
const assigned = st3.setSubjectRoles('group:134993546', ['gq'], { actor: 'unit' })
check('自定义角色挂到主体上原样保存（不再被改写成 guest）', assigned.join(',') === 'gq', JSON.stringify(assigned))
check('从库里读回来还是 gq', (st3.loadPolicy().assignments['group:134993546'] ?? []).join(',') === 'gq',
  JSON.stringify(st3.loadPolicy().assignments['group:134993546']))
check('owner 仍然按历史别名映射到 admin',
  st3.setSubjectRoles('user:1001', ['owner'], { actor: 'unit' }).join(',') === 'admin')
check('认不出的角色被丢掉（fail-closed，不会静默变 guest）',
  st3.setSubjectRoles('user:1002', ['nope'], { actor: 'unit' }).length === 0)
st3.setSubjectRoles('user:1003', ['admin', 'gq'], { actor: 'unit' })
check('多身份（admin + 自定义角色）取并集保存',
  st3.loadPolicy().assignments['user:1003'].sort().join(',') === 'admin,gq')
st3.close()

// ===== v2：资源 / 语料 / 会话快照 / 写前备份 =====
const v2 = openAclStore(dbFile, { create: false })
const res = v2.upsertResource({ id: 'dir:shared', kind: 'dir', uri: 'subjects/shared', label: '共享只读区' })
check('资源写入并读回', res?.id === 'dir:shared' && res.kind === 'dir', JSON.stringify(res))
v2.upsertResource({ id: 'svc:ecs', kind: 'service', uri: 'ecs:prod', label: 'ECS 生产' })
const unknownGrant = v2.setResourceGrants('guest', [{ resourceId: 'no-such-resource', actions: ['read'] }])
check('授权不存在的资源被丢弃（fail-closed）', unknownGrant.length === 0, JSON.stringify(unknownGrant))
const grants = v2.setResourceGrants('guest', [{ resourceId: 'dir:shared', actions: ['read', 'bogus'] }])
check('资源授权只保留合法动作', grants.length === 1 && grants[0].actions.join(',') === 'read', JSON.stringify(grants))
const policyV2 = v2.loadPolicy()
check('策略快照带 resources（含 grants）',
  policyV2.resources?.['dir:shared']?.grants?.guest?.join(',') === 'read', JSON.stringify(policyV2.resources ?? {}))

v2.upsertCorpus({ id: 'lore', name: '世界观', kind: 'files', payloadRef: 'lore' })
v2.upsertCorpus({ id: 'off', name: '停用', kind: 'files', payloadRef: 'off', enabled: false })
const bound = v2.setCorpusBindings('group:2001', ['lore', 'off'])
check('语料绑定落库（含停用的那条）', bound.join(',') === 'lore,off', JSON.stringify(bound))
const notFound = v2.setCorpusBindings('group:2001', ['lore', 'nope'])
check('绑定不存在的语料被丢弃', notFound.join(',') === 'lore', JSON.stringify(notFound))
const policyV3 = v2.loadPolicy()
check('策略快照带 corpora + corpusBindings',
  policyV3.corpora?.lore?.payloadRef === 'lore' && (policyV3.corpusBindings['group:2001'] ?? []).includes('lore'),
  JSON.stringify(policyV3.corpusBindings))
check('停用的语料在快照里 enabled=false', policyV3.corpora.off.enabled === false)

v2.recordSession({ subjectId: 'group:2001', sessionId: 'session-aaaa', roles: ['guest'], surface: { readonly: true, allowedTools: ['read'] } })
v2.recordSession({ subjectId: 'group:2001', sessionId: 'session-aaaa', roles: ['guest'], surface: { readonly: false, allowedTools: [] } })
const sessions = v2.listSessions(10)
check('会话快照按 session_id 覆盖而不是重复插入',
  sessions.filter((x) => x.sessionId === 'session-aaaa').length === 1, JSON.stringify(sessions.map((x) => x.sessionId)))
check('桥接建会话时会自己写快照（端到端那条已落库）',
  sessions.some((x) => String(x.sessionId).startsWith('qq-')) && sessions.some((x) => x.subjectId === 'group:2001'), JSON.stringify(sessions.map((x) => x.subjectId)))
check('会话快照里的角色与能力面可读回',
  sessions[0].roles.join(',') === 'guest' && sessions[0].surface.allowedTools.length === 0, JSON.stringify(sessions[0]))
check('清理旧会话快照', typeof v2.pruneSessions(Date.now() + 1000) === 'number')

const bakCount = readdirSync(join(root, 'config')).filter((n) => n.includes('.bak-')).length
check('配置类写操作留下写前备份', bakCount > 0, `bak=${bakCount}`)
v2.close()

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
