/**
 * 权限控制台 HTTP 面验收：鉴权、快照、写操作（含审计）、非法输入拒绝、页面可用。
 *
 * 全部走真实 HTTP（随机端口），不碰线上库（用临时库）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

const token = createAclToken()
const ui = await startAclConsole({ file: dbFile, token, ui: '<!doctype html><title>ACL</title>' })
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
