/**
 * 权限"声明了但没接"的缺口补齐验收（SPEC 四）：
 *   1. persona.text —— 没这个权限就不注入人格；
 *   2. qq.write.* —— 出站写动作在**执行期**再判一次（工具注册了也不等于能发）；
 *   3. 限额 —— 生图冷却/日限优先取角色限额（多身份取最宽松）；
 *   4. 其余命令 —— /export 这类走 canRun，没权限就落到模型（与迁移前一致）。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'
import { buildPolicyFromConfig } from '../lib/acl-policy.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-enforce-'))
const BOT = 999
const ADMIN = 1001
const GUEST = 1002
const GROUP = 2001
const IDENTITY = {
  enabled: true,
  map: { [ADMIN]: 'owner' },
  defaultRole: 'guest',
  groupRole: 'guest',
  roles: { owner: { preset: 'qq-coding', permission: 'danger-full-access', cwd: join(root, 'state') }, guest: { preset: 'qq-readonly' } },
}

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
    const record = { sessionId: String(sessionId), meta: options.meta ?? {}, sections: [], tools: [], restrict: [], guards: [] }
    const agentCtx = {
      systemPrompt: { section: (section) => record.sections.push(section) },
      tools: {
        register: (tool) => record.tools.push(tool),
        restrict: (spec) => record.restrict.push(spec),
        guard: (fn) => record.guards.push(fn),
        get: () => undefined,
      },
    }
    if (options.setup) await options.setup(agentCtx)
    const agent = {
      id: String(sessionId),
      status: 'idle',
      followup: (message) => {
        const text = (message.content ?? []).map((b) => b.text ?? '').join('')
        record.followups = [...(record.followups ?? []), text]
        setTimeout(() => emit(String(sessionId), `（回复）${text.slice(0, 40)}`), 5)
      },
      cancel: () => {},
    }
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

function makeBridge({ extra = {}, stateDir = join(root, 'state') } = {}) {
  mkdirSync(stateDir, { recursive: true })
  const config = Config({
    cwd: stateDir,
    dataRoot: join(root, 'data'),
    allowUsers: [ADMIN, GUEST],
    allowGroups: [GROUP],
    botQq: BOT,
    adminEnabled: false,
    sessionResumeEnabled: false,
    historyArchiveEnabled: false,
    memoryEnabled: false,
    identity: IDENTITY,
    ...extra,
  })
  const server = new MockServer()
  const ctx = makeCtx()
  const bridge = new QQBridge(ctx.ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  return { bridge, server, built: ctx.built, config }
}

let seq = 0
async function send(server, text, { userId = GUEST, groupId = GROUP, waitMs = 400 } = {}) {
  const before = server.sent.length
  server.emit('message', {
    bot: server.socket, userId, messageType: groupId ? 'group' : 'private', groupId, text,
    atMe: true, ats: groupId ? [BOT] : [], reply: null, records: [], images: [], files: [],
    messageId: `m${++seq}`, senderName: 'tester', raw: { message: [] },
  })
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && server.sent.length === before) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 30))
  return server.sent.slice(before).map((i) => i.segments.map((s) => s.data?.text ?? `[${s.type}]`).join('')).join('\n')
}

// ===== 1. persona.text =====
const personaOn = makeBridge({ stateDir: join(root, 's1') })
await send(personaOn.server, '你好')
const personaSection = personaOn.built.at(-1).sections.find((s) => String(s.name ?? '').includes('persona'))
check('有 persona.text 权限 → 注入人格段', Boolean(personaSection), personaOn.built.at(-1).sections.map((s) => s.name).join(','))
personaOn.bridge.stop()

const personaOff = makeBridge({ stateDir: join(root, 's2') })
personaOff.bridge.aclCache = {
  at: Date.now(),
  policy: { ...buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN] }), assignments: { [`group:${GROUP}`]: ['guest'] }, roles: { ...buildPolicyFromConfig({ identity: IDENTITY }).roles, guest: { id: 'guest', permissions: [], denies: [], limits: {} } } },
}
await send(personaOff.server, '你好')
const sectionsOff = personaOff.built.at(-1).sections.map((s) => s.name)
check('没有 persona.text 权限 → 不注入人格段', !sectionsOff.some((n) => String(n).includes('persona')), sectionsOff.join(','))
check('但会话本身照常可用（桥接规则段还在）', sectionsOff.includes('qq-onebot-bridge'), sectionsOff.join(','))
personaOff.bridge.stop()

// ===== 2. qq.write.* 执行期判定 =====
const write = makeBridge({ stateDir: join(root, 's3'), extra: { agentMediaToolsEnabled: true } })
// 先给 guest 补上 media 能力（否则工具根本不会注册）
const policyWithMedia = buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN] })
policyWithMedia.roles.guest = {
  ...policyWithMedia.roles.guest,
  permissions: [...policyWithMedia.roles.guest.permissions, 'tool.chat.media', 'qq.write.image', 'qq.write.file', 'qq.write.voice'],
}
policyWithMedia.assignments[`group:${GROUP}`] = ['guest']
write.bridge.aclCache = { at: Date.now(), policy: policyWithMedia }
await send(write.server, '你好')
const mediaSession = write.built.at(-1)
const sendImage = mediaSession.tools.find((t) => t.name === 'qq_send_image')
check('补了 media 权限后注册了 qq_send_image', Boolean(sendImage), mediaSession.tools.map((t) => t.name).join(','))
// 再模拟"控制台把 qq.write.image 禁掉"（会话已固化，注册不会重跑）→ 执行期必须拦住
const denied = { ...policyWithMedia, subjectDenies: { [`group:${GROUP}`]: ['qq.write.image'] } }
write.bridge.aclCache = { at: Date.now(), policy: denied }
const gateResult = sendImage ? await sendImage.execute({ path: '/tmp/x.png' }) : { detail: '' }
check('执行期 deny 生效：注册过的发图工具也拒绝执行',
  String(gateResult.detail ?? '').includes('权限不足'), JSON.stringify(gateResult))
write.bridge.stop()

// ===== 3. 生图限额取角色限额 =====
const gen = makeBridge({ stateDir: join(root, 's4'), extra: { imageGenEnabled: true, imageGenCommand: '/画', imageGenCooldownSeconds: 10 } })
const genPolicy = buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN] })
genPolicy.roles.guest = { ...genPolicy.roles.guest, limits: { imageGenCooldownSeconds: 600, imageGenDailyLimit: 5 } }
genPolicy.assignments[`user:${ADMIN}`] = ['admin', 'guest']
gen.bridge.aclCache = { at: Date.now(), policy: genPolicy }
const first = await send(gen.server, '/画 一只鲸鱼', { groupId: 0, userId: ADMIN })
const second = await send(gen.server, '/画 再来一只', { groupId: 0, userId: ADMIN })
check('第一次生图走下去了（不是被冷却拦的）', !first.includes('喘口气'), first.trim())
check('第二次被角色限额的冷却拦住（600 秒，配置里只有 10 秒）', second.includes('喘口气'), second.trim())
gen.bridge.stop()

// ===== 4. 其余命令走 canRun =====
const exports = makeBridge({ stateDir: join(root, 's5'), extra: { exportEnabled: true } })
const allowExport = await send(exports.server, '/export')
check('guest 默认可以 /export（有 cmd.export）', !allowExport.includes('（回复）/export') || allowExport.includes('导出'), allowExport.trim())
// 命令按**发言人**判（D-8）：所以 deny 要压在 user 主体上，压在群主体上不生效。
const deniedExport = { ...buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN] }), subjectDenies: { [`user:${GUEST}`]: ['cmd.export'] } }
deniedExport.assignments[`group:${GROUP}`] = ['guest']
exports.bridge.aclCache = { at: Date.now(), policy: deniedExport }
const blocked = await send(exports.server, '/export')
check('deny 掉发送者的 cmd.export 之后 /export 落到模型', blocked.includes('（回复）'), blocked.trim())
const groupOnlyDeny = { ...buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN] }), subjectDenies: { [`group:${GROUP}`]: ['cmd.export'] } }
groupOnlyDeny.assignments[`group:${GROUP}`] = ['guest']
exports.bridge.aclCache = { at: Date.now(), policy: groupOnlyDeny }
const notBlocked = await send(exports.server, '/export')
check('群主体上的 deny 不影响命令判定（命令按发言人，D-8）', !notBlocked.includes('（回复）'), notBlocked.trim())
exports.bridge.stop()

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
