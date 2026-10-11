/**
 * 权限模型 P0 验收测试：词表 / 能力注册表 / PDP 判定。
 *
 * 覆盖 SPEC-rbac-console.md 的规则：
 *   - 词表与注册表自检（id 唯一、引用存在、字段齐全）；
 *   - 范围匹配（own / shared / 具体主体 / 通配）；
 *   - 多身份取并集（"取最高"）；
 *   - deny 最外层覆盖（角色级 + 主体级 + 通配 deny）；
 *   - limits 多身份取最宽松；
 *   - fail-closed（未知权限点、未知角色）。
 */
import { PERMISSIONS, permissionSatisfies, isKnownPermission, splitPermission, validatePermissionTable } from '../lib/permissions.js'
import { CAPABILITIES, LIMITS, validateCapabilityTable } from '../lib/capabilities.js'
import { builtinRoles, emptyPolicy, evaluate, explain, limitsFor, rolesFor } from '../lib/acl.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ===== 1. 词表自检 =====
const permProblems = validatePermissionTable()
check('权限词表自检通过', permProblems.length === 0, permProblems.join(' | '))
check('权限点数量合理（>=50）', PERMISSIONS.length >= 50, `共 ${PERMISSIONS.length} 条`)

// ===== 2. 能力注册表自检 =====
const capProblems = validateCapabilityTable()
check('能力注册表自检通过', capProblems.length === 0, capProblems.join(' | '))
check('每个能力都声明了用途动作（command/intent/tool/ops/media/sys）',
  CAPABILITIES.every((item) => ['command', 'intent', 'tool', 'ops', 'media', 'sys'].includes(item.kind)))
check('能力注册表覆盖 10 个 qq_* 工具',
  CAPABILITIES.filter((item) => (item.tool ?? []).some((t) => t.startsWith('qq_'))).length >= 6)
check('每个 QQ 工具都在注册表里',
  ['qq_send_image', 'qq_send_file', 'qq_send_voice', 'qq_react', 'qq_member_info',
    'qq_recent_history', 'qq_search_history', 'qq_recall', 'qq_face_list', 'qq_face_send']
    .every((tool) => CAPABILITIES.some((item) => (item.tool ?? []).includes(tool))))

// ===== 3. 范围匹配 =====
check('基础点相等 + 无范围需求 → 放行', permissionSatisfies('cmd.chat', 'cmd.chat'))
check('基础点不同 → 拒绝', !permissionSatisfies('cmd.chat', 'cmd.help'))
check('范围一致 → 放行', permissionSatisfies('tool.fs.read:u1001', 'tool.fs.read:u1001'))
check('范围不一致 → 拒绝', !permissionSatisfies('tool.fs.read:u1001', 'tool.fs.read:u1002'))
check('通配授权匹配任意范围', permissionSatisfies('tool.fs.read:*', 'tool.fs.read:u1002'))
check('无范围的授权匹配带范围的需求（基础点级授予）', permissionSatisfies('tool.fs.read', 'tool.fs.read:u1002'))
check('带范围的授权不满足无范围需求', !permissionSatisfies('tool.fs.read:u1', 'tool.fs.read'))
check('splitPermission 拆基础点与范围', splitPermission('tool.fs.read:u1').base === 'tool.fs.read'
  && splitPermission('tool.fs.read:u1').scope === 'u1')
check('带范围的权限点算已知', isKnownPermission('tool.fs.read:u1001') && isKnownPermission('persona.corpus:writing'))
check('未知权限点不算已知', !isKnownPermission('cmd.nope'))

// ===== 4. 角色解析 =====
const policy = emptyPolicy()
check('内置角色有 admin 与 guest', Boolean(policy.roles.admin && policy.roles.guest))
check('没有分配时落到默认角色 guest', rolesFor(policy, 'group:123456').join(',') === 'guest')
check('admin 的授权里包含全部权限点基础',
  PERMISSIONS.every((item) => policy.roles.admin.permissions.includes(item.id)))
const multi = emptyPolicy()
multi.assignments['user:1'] = ['guest', 'admin']
check('多身份解析出两个角色（取并集的基础）', rolesFor(multi, 'user:1').sort().join(',') === 'admin,guest')

// ===== 5. PDP：基础角色 =====
const guest = evaluate(policy, 'group:100', { need: ['cmd.chat'] })
check('guest 可以对话', guest.allowed === true, explain(guest))
check('guest 不可以踢人', evaluate(policy, 'group:100', { need: ['group.ops.kick'] }).allowed === false)
check('guest 不能切工作区', evaluate(policy, 'group:100', { need: ['cmd.workspace'] }).allowed === false)
check('guest 能读自己的范围（own 解析成主体）',
  evaluate(policy, 'group:100', { need: ['tool.fs.read:group:100'] }).allowed === true)
check('guest 读不了别的主体（群 A 读群 B）',
  evaluate(policy, 'group:100', { need: ['tool.fs.read:group:200'] }).allowed === false)
check('guest 读不了别的主体（群读私聊）',
  evaluate(policy, 'group:100', { need: ['tool.fs.read:user:10001'] }).allowed === false)
check('guest 能读共享只读区', evaluate(policy, 'group:100', { need: ['tool.fs.read:shared'] }).allowed === true)
check('guest 不能写任何范围', evaluate(policy, 'group:100', { need: ['tool.fs.write:group:100'] }).allowed === false)
check('guest 不能执行 shell', evaluate(policy, 'group:100', { need: ['tool.shell'] }).allowed === false)
check('guest 不能读其他会话', evaluate(policy, 'group:100', { need: ['tool.session.read'] }).allowed === false)
check('guest 能用联网搜索', evaluate(policy, 'group:100', { need: ['tool.net.search'] }).allowed === true)

// ===== 6. PDP：多身份取最高 =====
const superUser = evaluate(multi, 'user:1', { need: ['tool.shell', 'group.ops.kick', 'cmd.workspace'] })
check('多身份（guest+admin）取并集 → 全放行', superUser.allowed === true, explain(superUser))
check('多身份仍然列出生效角色', superUser.roles.sort().join(',') === 'admin,guest')

// ===== 7. PDP：deny 最外层覆盖 =====
const denyRole = emptyPolicy()
denyRole.roles.guest.denies = ['cmd.chat']
check('角色级 deny 覆盖 allow', evaluate(denyRole, 'group:100', { need: ['cmd.chat'] }).allowed === false)
check('角色级 deny 只影响被禁的那一项',
  evaluate(denyRole, 'group:100', { need: ['cmd.help'] }).allowed === true)
const denySubject = emptyPolicy()
denySubject.subjectDenies['group:100'] = ['cmd.help']
check('主体级 deny 覆盖 allow', evaluate(denySubject, 'group:100', { need: ['cmd.help'] }).allowed === false)
check('主体级 deny 不波及其他主体', evaluate(denySubject, 'group:200', { need: ['cmd.help'] }).allowed === true)
const denyScope = emptyPolicy()
denyScope.roles.guest.denies = ['tool.fs.read:*']
const scoped = evaluate(denyScope, 'group:100', { need: ['tool.fs.read:group:100', 'tool.fs.read:shared'] })
check('通配 deny 覆盖所有范围', scoped.allowed === false && scoped.denied.length === 2, explain(scoped))
const denyWinsOverAdmin = emptyPolicy()
denyWinsOverAdmin.assignments['user:1'] = ['admin']
denyWinsOverAdmin.subjectDenies['user:1'] = ['tool.shell']
check('deny 压过 superuser 身份', evaluate(denyWinsOverAdmin, 'user:1', { need: ['tool.shell'] }).allowed === false)

// ===== 8. PDP：limits 取最宽松 =====
const limitsPolicy = emptyPolicy()
limitsPolicy.assignments['user:2'] = ['guest', 'admin']
const merged = limitsFor(limitsPolicy, rolesFor(limitsPolicy, 'user:2'), ['imageGenDailyLimit', 'imageGenCooldownSeconds'])
check('max 类 limit 取最大（每日上限）', merged.imageGenDailyLimit === null || merged.imageGenDailyLimit >= 20, JSON.stringify(merged))
check('min 类 limit 取最小（冷却秒数）', merged.imageGenCooldownSeconds === 0, JSON.stringify(merged))
const onlyGuest = limitsFor(emptyPolicy(), ['guest'], ['imageGenDailyLimit'])
check('角色没配 limit 时用注册表默认值', onlyGuest.imageGenDailyLimit === LIMITS.imageGenDailyLimit.default, JSON.stringify(onlyGuest))
const twoRoles = emptyPolicy()
twoRoles.roles.a = { id: 'a', permissions: [], denies: [], limits: { dailyMessageLimit: 10 } }
twoRoles.roles.b = { id: 'b', permissions: [], denies: [], limits: { dailyMessageLimit: 100 } }
check('两个普通角色合并取最宽松（max）', limitsFor(twoRoles, ['a', 'b'], ['dailyMessageLimit']).dailyMessageLimit === 100)
check('未知 limit 被忽略', Object.keys(limitsFor(twoRoles, ['a'], ['nope'])).length === 0)

// ===== 9. fail-closed =====
const unknown = evaluate(policy, 'group:100', { need: ['cmd.does-not-exist'] })
check('未知权限点 → 拒绝且理由明确', unknown.allowed === false && unknown.reason === 'unknown-permission', explain(unknown))
const noRole = emptyPolicy()
noRole.assignments['group:100'] = ['bogus-role']
check('分配里只有未知角色 → 没有任何角色 → 拒绝', evaluate(noRole, 'group:100', { need: ['cmd.chat'] }).allowed === false)
check('缺权限时 reason=missing-permission', evaluate(policy, 'group:100', { need: ['group.ops.kick'] }).reason === 'missing-permission')
check('被 deny 时 reason=denied', evaluate(denyRole, 'group:100', { need: ['cmd.chat'] }).reason === 'denied')
check('全通过时 reason=allowed', evaluate(policy, 'group:100', { need: ['cmd.chat'] }).reason === 'allowed')

// ===== 10. 与现状能力的对齐（P1 迁移前的基线断言） =====
const imageCap = CAPABILITIES.find((item) => item.id === 'cmd.image')
check('生图能力同时要求命令权限与生图工具权限',
  imageCap.need.includes('cmd.image') && imageCap.need.includes('tool.image.generate'))
check('生图能力登记了冷却与日限', (imageCap.limits ?? []).includes('imageGenCooldownSeconds')
  && (imageCap.limits ?? []).includes('imageGenDailyLimit'))
check('群管能力标注了当前门禁（adminEnabled）',
  CAPABILITIES.filter((item) => item.kind === 'ops').every((item) => item.gate.kind === 'adminFlag'))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
