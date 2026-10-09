/**
 * 门禁迁移的**等价性**验收（SPEC-rbac-console.md §8.3 P1）。
 *
 * 迁移目标：把散在代码里的三类门禁（`#isAdmin` 白名单 / `#roleOf().guest` / 功能开关）
 * 收编到一个判定点 `#canRun(message, <能力 id>)`，且**行为不变**。
 *
 * 这个文件干两件事：
 *   1. 策略翻译的单元断言（identity.map / adminUsers / groupRoles / identity 关闭的兜底）；
 *   2. 用真实命令走一遍旧语义：超管能做的、访客做不了的、以及 deny 覆盖与多身份"取最高"。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'
import { evaluate } from '../lib/acl.js'
import { buildPolicyFromConfig, normalizeRoleId } from '../lib/acl-policy.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-acl-gates-'))
const stateDir = join(root, 'state')
mkdirSync(stateDir, { recursive: true })

const BOT = 999
const ADMIN = 1001
const GUEST = 1002
const GROUP = 2001

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: `mid${this.sent.length}` })
  }
  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }
  currentSocket() { return this.socket }
}

function makeCtx() {
  const handlers = new Map()
  const built = []
  const emitSession = (sessionId, text) => {
    for (const handler of handlers.get('session/event') ?? []) {
      handler({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    }
  }
  const build = async (sessionId, options) => {
    const record = { sessionId: String(sessionId), meta: options.meta ?? {}, followups: [] }
    const agentCtx = {
      systemPrompt: { section: () => {} },
      tools: { register: () => {}, restrict: () => {}, get: () => undefined },
    }
    if (options.setup) await options.setup(agentCtx)
    const agent = {
      id: String(sessionId),
      status: 'idle',
      followup: (message) => {
        const text = (message.content ?? []).map((block) => block.text ?? '').join('')
        record.followups.push(text)
        setTimeout(() => emitSession(String(sessionId), `（回复）${text.slice(0, 40)}`), 5)
      },
      cancel: () => {},
    }
    built.push(record)
    return { agent, dispose: async () => {} }
  }
  const ctx = {
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    get: () => undefined,
    agents: {
      create: async (options) => build(options.sessionId, options),
      resume: async (options) => build(options.resumeSessionId, options),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return { ctx, built }
}

function makeBridge({ identity = undefined, adminUsers = [ADMIN], cwd = stateDir } = {}) {
  mkdirSync(cwd, { recursive: true })
  const config = Config({
    cwd,
    allowUsers: [ADMIN, GUEST],
    acceptPrivate: true,
    allowGroups: [GROUP],
    botQq: BOT,
    adminEnabled: true,
    adminUsers,
    sessionResumeEnabled: true,
    historyArchiveEnabled: false,
    memoryEnabled: false,
    ...(identity === undefined ? {} : { identity }),
  })
  const server = new MockServer()
  const ctx = makeCtx()
  const bridge = new QQBridge(ctx.ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  return { bridge, server, built: ctx.built, config }
}

const IDENTITY = {
  enabled: true,
  map: { [ADMIN]: 'owner' },
  defaultRole: 'guest',
  groupRole: 'guest',
  roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly' } },
}

let seq = 0
async function send(server, text, { userId = ADMIN, groupId = 0, waitMs = 500 } = {}) {
  const before = server.sent.length
  server.emit('message', {
    bot: server.socket,
    userId,
    messageType: groupId ? 'group' : 'private',
    groupId,
    text,
    atMe: groupId ? true : false,
    ats: groupId ? [BOT] : [],
    reply: null,
    records: [],
    images: [],
    files: [],
    messageId: `m${++seq}`,
    senderName: 'tester',
    raw: { message: [] },
  })
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && server.sent.length === before) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 30))
  return server.sent.slice(before).map((item) => item.segments.map((s) => s.data?.text ?? `[${s.type}]`).join('')).join('\n')
}

// ===== 1. 策略翻译（配置 → 策略对象） =====
check('normalizeRoleId: owner → admin（历史别名）', normalizeRoleId('owner') === 'admin')
check('normalizeRoleId: 不认识的角色 → guest（fail-closed）', normalizeRoleId('adminx') === 'guest'
  && normalizeRoleId(true) === 'guest' && normalizeRoleId('') === 'guest')

const p1 = buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN, GUEST] })
check('identity.map 的 owner 拿到 admin', p1.assignments[`user:${ADMIN}`].includes('admin'))
check('adminUsers 里的每个号都拿到 admin', p1.assignments[`user:${GUEST}`].includes('admin'))
check('多来源汇合时不重复、不互斥', new Set(p1.assignments[`user:${ADMIN}`]).size === p1.assignments[`user:${ADMIN}`].length)
check('groupRoles 落到群主体', buildPolicyFromConfig({
  identity: { ...IDENTITY, groupRoles: { [GROUP]: 'owner' } },
}).assignments[`group:${GROUP}`].includes('admin'))
check('人主体默认角色取自 defaultRole', p1.defaultRoleByKind.user === 'guest')
check('群主体默认角色取自 groupRole', p1.defaultRoleByKind.group === 'guest')

const p2 = buildPolicyFromConfig({ identity: { enabled: false }, adminUsers: [] })
check('identity 关闭 → 默认角色是 legacy（会话能力全开、命令授权不放大）', p2.defaultRoleByKind.user === 'legacy')
check('legacy 能做 shell（会话能力）', evaluate(p2, `user:${GUEST}`, { need: ['tool.shell'] }).allowed === true)
check('legacy 不能踢人（命令授权仍看白名单）', evaluate(p2, `user:${GUEST}`, { need: ['group.ops.kick'] }).allowed === false)
check('legacy 不能 /handoff', evaluate(p2, `user:${GUEST}`, { need: ['cmd.handoff'] }).allowed === false)
check('legacy 可以 /ws（旧代码里 owner 角色即可）', evaluate(p2, `user:${GUEST}`, { need: ['cmd.workspace'] }).allowed === true)

// ===== 2. 真实命令的等价性：超管 vs 访客 =====
const admin = makeBridge({ identity: IDENTITY })

const clearAdmin = await send(admin.server, '/clear', { userId: ADMIN })
check('超管 /clear 生效（走管理命令分支）', clearAdmin.includes('已清空') || clearAdmin.includes('清空'), clearAdmin.trim())
const clearGuest = await send(admin.server, '/clear', { userId: GUEST })
check('访客 /clear 不走管理分支（落到模型，旧行为一致）', clearGuest.includes('（回复）'), clearGuest.trim())

const handoffGuest = await send(admin.server, '/handoff', { userId: GUEST })
check('访客 /handoff 被明确拒绝', handoffGuest.includes('只对管理员开放'), handoffGuest.trim())
const handoffAdmin = await send(admin.server, '/handoff', { userId: ADMIN })
check('超管 /handoff 不被拦（进入交接面板）', !handoffAdmin.includes('只对管理员开放'), handoffAdmin.trim())

const wsGuest = await send(admin.server, '/ws', { userId: GUEST })
check('访客 /ws 被拒绝', wsGuest.includes('只对管理员开放'), wsGuest.trim())
const wsAdmin = await send(admin.server, '/ws', { userId: ADMIN })
check('超管 /ws 能看到工作区列表（或登记表读不到）',
  wsAdmin.includes('可切换的工作区') || wsAdmin.includes('没读到工作区登记表'), wsAdmin.trim())

const kickGuest = await send(admin.server, `/kick ${ADMIN}`, { userId: GUEST, groupId: GROUP })
check('访客在群里踢人不生效（落到模型）', kickGuest.includes('（回复）'), kickGuest.trim())

// ===== 3. deny 覆盖：显式禁止压过超管身份 =====
const denied = makeBridge({ identity: IDENTITY })
const base = buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN] })
const withDeny = { ...base, subjectDenies: { [`user:${ADMIN}`]: ['group.ops.clear'] } }
denied.bridge.aclCache = { at: Date.now(), policy: withDeny }
const clearDenied = await send(denied.server, '/clear', { userId: ADMIN })
check('deny 覆盖后超管 /clear 也失效', clearDenied.includes('（回复）'), clearDenied.trim())
const handoffStillOk = await send(denied.server, '/handoff', { userId: ADMIN })
check('deny 只影响被禁的那一项，其他照旧', !handoffStillOk.includes('只对管理员开放'), handoffStillOk.trim())

// ===== 4. 多身份取并集 =====
const multi = makeBridge({ identity: IDENTITY })
const multiPolicy = buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN] })
multiPolicy.assignments[`user:${GUEST}`] = ['guest', 'admin']
multi.bridge.aclCache = { at: Date.now(), policy: multiPolicy }
const handoffMulti = await send(multi.server, '/handoff', { userId: GUEST })
check('guest + admin 双身份 → 取并集，命令可用', !handoffMulti.includes('只对管理员开放'), handoffMulti.trim())

// ===== 5. 会话能力面不受命令授权影响（两条轴分开） =====
// 用一个干净的 cwd：否则会续接前面几个用例写下的 qq-sessions.json，
// 走"续接"分支（meta 为空），断言就测不到"新建时会话用哪个 preset"。
const legacy = makeBridge({ identity: undefined, adminUsers: [], cwd: join(root, 'legacy-state') })
await send(legacy.server, '你好')
check('identity 关闭时，会话照旧按 owner（qq-coding）建立',
  legacy.built[legacy.built.length - 1]?.meta?.agentPreset === 'qq-coding',
  String(legacy.built[legacy.built.length - 1]?.meta?.agentPreset))
const legacyClear = await send(legacy.server, '/clear')
check('同一个会话里 /clear 仍按旧规则被拦（命令授权看白名单）', legacyClear.includes('（回复）'), legacyClear.trim())

for (const item of [admin, denied, multi, legacy]) item.bridge.stop()
rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
