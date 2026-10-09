/**
 * 权限控制台 HTTP 面验收：鉴权、快照、写操作（含审计）、非法输入拒绝、页面可用。
 *
 * 全部走真实 HTTP（随机端口），不碰线上库（用临时库）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAclStore } from '../lib/acl-store.js'
import { applyAclAction, createAclToken, startAclConsole } from '../control/lib/acl-console.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-aclconsole-'))
const dbFile = join(root, 'config', 'acl.db')
mkdirSync(join(root, 'config'), { recursive: true })
const store = openAclStore(dbFile)
store.syncPermissions()
store.seedBuiltinRoles()
store.importAssignmentsFromConfig({ identity: { enabled: true, map: { 1001: 'owner' }, defaultRole: 'guest', groupRole: 'guest' }, adminUsers: [1002] })
store.close()

const corporaRoot = join(root, 'config', 'corpora')
mkdirSync(join(corporaRoot, 'lore'), { recursive: true })
writeFileSync(join(corporaRoot, 'lore', '01.md'), '世界观第一条')
// 共享只读区（资源 dir:shared 的 uri 指向这里）
mkdirSync(join(root, 'subjects', 'shared'), { recursive: true })

const token = createAclToken()
const ui = await startAclConsole({ file: dbFile, token, ui: '<!doctype html><title>ACL</title>', dataRoot: root })
const base = `http://127.0.0.1:${ui.port}`

const get = (path, headers = {}) => fetch(`${base}${path}`, { headers })
const post = (payload, headers = {}) => fetch(`${base}/api/acl?token=${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
})

// ===== 1. 鉴权 =====
check('不带 token 的 API 请求 → 401', (await get('/api/acl')).status === 401)
check('token 不对 → 401', (await get('/api/acl?token=wrong')).status === 401)
check('只绑 127.0.0.1（URL 是回环地址）', ui.url.startsWith('http://127.0.0.1:'))
check('页面无需 token 也能打开（HTML 本体不含数据）', (await get('/')).status === 200)
const crossSite = await get('/api/acl', { origin: 'https://evil.example.com' })
check('跨站 Origin 被拒 → 403', crossSite.status === 403)

// ===== 2. 快照 =====
const snapshot = await (await get(`/api/acl?token=${token}`)).json()
check('快照含角色/权限点/能力/审计',
  Boolean(snapshot.roles?.admin && snapshot.permissions?.length > 50 && snapshot.capabilities?.length > 20 && Array.isArray(snapshot.audit)))
check('快照里 admin 角色权限数与词表一致',
  snapshot.roles.admin.permissions.length === snapshot.permissions.length,
  `${snapshot.roles.admin.permissions.length} vs ${snapshot.permissions.length}`)
check('快照带库文件路径', snapshot.file === dbFile)
check('主体分配里有 user:1001 → admin', (snapshot.assignments['user:1001'] ?? []).includes('admin'))

// ===== 3. 写操作 =====
const setPerms = await post({ action: 'role-permissions', role: 'guest', permissions: ['cmd.chat', 'cmd.image', 'tool.net.search'] })
check('写角色权限 → 200 且只保留合法项', setPerms.status === 200, JSON.stringify(await setPerms.clone().json()))
const afterPerms = await (await get(`/api/acl?token=${token}`)).json()
check('改动立即可见', afterPerms.roles.guest.permissions.sort().join(',') === 'cmd.chat,cmd.image,tool.net.search')
check('写操作进了审计', afterPerms.audit.some((row) => row.action === 'set-role-permissions' && row.target === 'guest'))

const denyRes = await post({ action: 'subject-denies', subject: 'user:1001', denies: ['tool.shell'] })
check('写主体 deny → 200', denyRes.status === 200)
check('deny 出现在快照里',
  ((await (await get(`/api/acl?token=${token}`)).json()).subjectDenies['user:1001'] ?? []).includes('tool.shell'))

const assignRes = await post({ action: 'subject-roles', subject: 'group:2001', roles: ['owner'] })
check('写主体角色 → 200（owner 归一化成 admin）', assignRes.status === 200)
check('群主体拿到 admin',
  ((await (await get(`/api/acl?token=${token}`)).json()).assignments['group:2001'] ?? []).includes('admin'))

const createRole = await post({ action: 'role-create', id: 'vip', name: 'VIP 群', cloneFrom: 'guest' })
check('新建角色 → 200', createRole.status === 200)
const withVip = await (await get(`/api/acl?token=${token}`)).json()
check('新角色存在且克隆了权限', Boolean(withVip.roles.vip) && withVip.roles.vip.permissions.length > 0)

// ===== 4. 非法输入一律拒绝 =====
const badPerm = await post({ action: 'role-permissions', role: 'guest', permissions: ['cmd.nope'] })
check('权限点不在词表 → 400', badPerm.status === 400, JSON.stringify(await badPerm.clone().json()))
const badSubject = await post({ action: 'subject-roles', subject: 'mysql:1', roles: ['guest'] })
check('主体写法不对 → 400', badSubject.status === 400)
const badRole = await post({ action: 'role-permissions', role: 'not-exist', permissions: ['cmd.chat'] })
check('角色不存在 → 400', badRole.status === 400)
const deleteBuiltin = await post({ action: 'role-delete', id: 'guest' })
check('内置角色不允许删除 → 400', deleteBuiltin.status === 400)
const unknownAction = await post({ action: 'nope' })
check('未知操作 → 400', unknownAction.status === 400)
const badJson = await fetch(`${base}/api/acl?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
check('请求体不是 JSON → 400', badJson.status === 400)

// ===== 4b. v2：资源 / 语料 / 会话 =====
const resUp = await post({ action: 'resource-upsert', id: 'dir:shared', kind: 'dir', uri: 'subjects/shared', label: '共享只读区' })
check('资源写入 → 200', resUp.status === 200)
const resBadId = await post({ action: 'resource-upsert', id: '有中文的 id' })
check('非法资源 id → 400', resBadId.status === 400)
const grantRes = await post({ action: 'resource-grants', role: 'guest', grants: [{ resourceId: 'dir:shared', actions: ['read', 'nope'] }] })
check('资源授权 → 200', grantRes.status === 200)
const grantMissing = await post({ action: 'resource-grants', role: 'guest', grants: [{ resourceId: 'no-such', actions: ['read'] }] })
check('授权不存在的资源 → 400', grantMissing.status === 400)
const corpUp = await post({ action: 'corpus-upsert', id: 'lore', name: '世界观', kind: 'files', payloadRef: 'lore', enabled: true })
check('语料写入 → 200', corpUp.status === 200)
const bind = await post({ action: 'corpus-bindings', subject: 'group:2001', corpora: ['lore'] })
check('语料绑定 → 200', bind.status === 200)
const bindBad = await post({ action: 'corpus-bindings', subject: 'group:2001', corpora: ['nope'] })
check('绑定不存在的语料 → 400', bindBad.status === 400)
const snap2 = await (await get(`/api/acl?token=${token}`)).json()
check('快照带 resources/corpora/corpusBindings/sessions',
  Boolean(snap2.resources?.['dir:shared'] && snap2.corpora?.lore && snap2.corpusBindings?.['group:2001'] && Array.isArray(snap2.sessions)),
  JSON.stringify({ r: Object.keys(snap2.resources ?? {}), c: Object.keys(snap2.corpora ?? {}) }))
check('快照里的资源授权可读回', (snap2.resources['dir:shared'].grants.guest ?? []).join(',') === 'read')
check('资源带上判定点（dir:shared → tool.fs.read:shared）',
  snap2.resources['dir:shared'].wired === 'tool.fs.read:shared', String(snap2.resources['dir:shared'].wired))
check('资源的 uri 解析成绝对路径并判断存在（相对数据根）',
  snap2.resources['dir:shared'].path === join(root, 'subjects', 'shared') && snap2.resources['dir:shared'].exists === true,
  JSON.stringify({ path: snap2.resources['dir:shared'].path, exists: snap2.resources['dir:shared'].exists }))
// guest 在前面被改过权限（只剩三条），admin 才是"确实有 tool.fs.read:shared"的角色
await post({ action: 'resource-grants', role: 'admin', grants: [{ resourceId: 'dir:shared', actions: ['read'] }] })
const snap2b = await (await get(`/api/acl?token=${token}`)).json()
check('资源授权里列出真正有该判定点的角色（admin 有 tool.fs.read:shared，guest 被改过所以不算）',
  (snap2b.resources['dir:shared'].grantedRoles ?? []).includes('admin')
  && !(snap2b.resources['dir:shared'].grantedRoles ?? []).includes('guest'),
  JSON.stringify(snap2b.resources['dir:shared'].grantedRoles))
const unknownRes = await post({ action: 'resource-upsert', id: 'dir:whatever', kind: 'dir', uri: 'no/such/dir' })
const snap3 = await (await get(`/api/acl?token=${token}`)).json()
check('没接线的资源标成"仅登记"，且路径不存在如实显示',
  snap3.resources['dir:whatever'].wired === '' && snap3.resources['dir:whatever'].exists === false,
  JSON.stringify({ wired: snap3.resources['dir:whatever'].wired, exists: snap3.resources['dir:whatever'].exists }))

const preview = await (await get(`/api/acl/corpus-preview?token=${token}&subject=group:2001`)).json()
check('语料预览接口能解析文件', preview.items?.length === 1 && preview.text.includes('世界观第一条'), JSON.stringify(preview.items))
const previewBad = await get(`/api/acl/corpus-preview?token=${token}&subject=nope`)
check('语料预览缺主体格式 → 400', previewBad.status === 400)

const prune = await post({ action: 'session-prune', days: 30 })
check('会话快照清理 → 200', prune.status === 200)

// ===== 5. 导出 =====
const exported = await (await get(`/api/acl/export?token=${token}`)).json()
check('导出快照含 roles/assignments', Boolean(exported.roles && exported.assignments))

// ===== 6. 纯函数入口也测一遍（便于以后被 CLI 复用） =====
const store2 = openAclStore(dbFile, { create: false })
const direct = applyAclAction(store2, { action: 'role-denies', role: 'vip', denies: ['tool.image.generate'] }, { actor: 'unit' })
check('applyAclAction 直接调用可用', direct.ok === true && direct.status === 200)
const badDirect = applyAclAction(store2, { action: 'role-denies', role: 'vip', denies: ['nope.nope'] })
check('applyAclAction 对未知权限点返回 400', badDirect.ok === false && badDirect.status === 400)
store2.close()

await ui.close()
rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
