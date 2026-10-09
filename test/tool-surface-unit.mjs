/**
 * DSH 插件能力的权限管控（zfq 2026-10-09 纠正的重点）。
 *
 * 要管的是**插件能力**：文件读写、shell、联网搜索、ECS/n8n/GH 运维工具、会话读取、生图……
 * 不是 QQ 群管那点权限。这个文件验收：
 *   1. `lib/tool-grants.js` 把权限点翻译成工具面（宿主级白名单 + 桥接 scoped 开关）；
 *   2. 会话真正落地时：**宿主级工具被 restrict 白名单裁剪**、
 *      **桥接 scoped 工具按权限决定注册**（restrict 管不到它们，只能不注册）；
 *   3. 只读角色不会被挂上带 shell 的 preset（qq-coding 的 bash 是 scoped 注册，restrict 挡不住）；
 *   4. deny 覆盖与多身份取并集对工具面同样生效。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'
import { buildPolicyFromConfig } from '../lib/acl-policy.js'
import { resolveToolSurface } from '../lib/tool-grants.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-tools-test-'))
const stateDir = join(root, 'state')
mkdirSync(stateDir, { recursive: true })

const BOT = 999
const ADMIN = 1001
const GUEST = 1002
const GROUP = 2001
const IDENTITY = {
  enabled: true,
  map: { [ADMIN]: 'owner' },
  defaultRole: 'guest',
  groupRole: 'guest',
  roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly' } },
}
const policy = buildPolicyFromConfig({ identity: IDENTITY, adminUsers: [ADMIN] })

// ===== 1. 工具面翻译（纯函数） =====
const adminSurface = resolveToolSurface(policy, `user:${ADMIN}`)
check('超管：不需要裁剪（全都要）', adminSurface.needRestrict === false)
check('超管：需要完整 preset（有 shell）', adminSurface.requiresFullPreset === true && adminSurface.scoped.shell === true)
check('超管：宿主级工具里含 bash / write / ecs',
  ['bash', 'write', 'edit', 'ecs_exec', 'n8n_status', 'gh_run_list', 'session_read', 'context_handoff']
    .every((name) => adminSurface.inheritedTools.includes(name)),
  adminSurface.inheritedTools.join(','))

const guestSurface = resolveToolSurface(policy, `group:${GROUP}`)
check('访客：需要裁剪', guestSurface.needRestrict === true)
check('访客：不需要完整 preset（没有 shell / 写权限）', guestSurface.requiresFullPreset === false)
check('访客：只读（readonly=true）', guestSurface.readonly === true)
check('访客：**没有** shell 工具', !guestSurface.inheritedTools.includes('bash'))
check('访客：**没有**写文件工具', !guestSurface.inheritedTools.includes('write') && !guestSurface.inheritedTools.includes('edit'))
check('访客：**没有** ECS / n8n / GH 运维工具',
  !['ecs_exec', 'ecs_status', 'ecs_upload', 'n8n_status', 'n8n_deploy_workflow', 'gh_run_list', 'gh_run_view']
    .some((name) => guestSurface.inheritedTools.includes(name)))
check('访客：**没有**读其他会话 / 交接工具',
  !guestSurface.inheritedTools.includes('session_read') && !guestSurface.inheritedTools.includes('context_handoff'))
check('访客：有联网搜索', guestSurface.inheritedTools.includes('web_search') && guestSurface.inheritedTools.includes('web_fetch'))
check('访客：有受限读工具（scoped 注册）', guestSurface.scoped.jailedFs === true)
check('访客：没有生图能力', guestSurface.scoped.imageGen === false)
check('访客：没有收发媒体（工具面里不含 QQ 出站工具组）',
  guestSurface.decisions['tool.chat.media'].allowed === false)

// deny 覆盖：显式禁掉联网
const deniedPolicy = { ...policy, subjectDenies: { [`user:${GUEST}`]: ['tool.net.search'] } }
const deniedSurface = resolveToolSurface(deniedPolicy, `user:${GUEST}`)
check('deny 覆盖：联网搜索被禁后不在白名单里',
  !deniedSurface.inheritedTools.includes('web_search') && deniedSurface.scoped.web === false,
  deniedSurface.inheritedTools.join(','))

// 多身份取并集：给访客再加一个"能读 ECS"的角色
const multiPolicy = { ...policy, roles: { ...policy.roles, ecsreader: { id: 'ecsreader', permissions: ['tool.mcp.ecs'], denies: [], limits: {} } } }
multiPolicy.assignments = { ...policy.assignments, [`user:${GUEST}`]: ['guest', 'ecsreader'] }
const multiSurface = resolveToolSurface(multiPolicy, `user:${GUEST}`)
check('多身份取并集：叠加的角色能让 ECS 工具进白名单', multiSurface.inheritedTools.includes('ecs_exec'), multiSurface.inheritedTools.join(','))

// ===== 2. 会话落地（真实装配） =====
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
    const record = {
      sessionId: String(sessionId), meta: options.meta ?? {},
      restrict: [], guards: [], tools: [], followups: [],
    }
    const agentCtx = {
      systemPrompt: { section: () => {} },
      tools: {
        register: (tool) => record.tools.push(tool?.name ?? '(anon)'),
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

function makeBridge() {
  const config = Config({
    cwd: stateDir,
    dataRoot: join(root, 'data'),
    allowUsers: [ADMIN, GUEST],
    acceptPrivate: true,
    allowGroups: [GROUP],
    botQq: BOT,
    identity: IDENTITY,
    sessionResumeEnabled: true,
    historyArchiveEnabled: false,
    memoryEnabled: false,
  })
  const server = new MockServer()
  const ctx = makeCtx()
  const bridge = new QQBridge(ctx.ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  return { bridge, server, built: ctx.built }
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

const b = makeBridge()
await send(b.server, '你好', { groupId: GROUP })
const guestSession = b.built[b.built.length - 1]
check('访客会话挂的是只读 preset', guestSession.meta.agentPreset === 'qq-readonly', String(guestSession.meta.agentPreset))
check('访客会话调用了 restrict 裁剪宿主级工具', guestSession.restrict.length === 1, JSON.stringify(guestSession.restrict))
const guestAllow = guestSession.restrict[0]?.allow ?? []
check('restrict 白名单里没有 bash / write / ecs',
  !['bash', 'write', 'edit', 'ecs_exec', 'n8n_status', 'gh_run_list', 'session_read', 'context_handoff'].some((n) => guestAllow.includes(n)),
  guestAllow.join(','))
check('restrict 白名单里保留联网搜索', guestAllow.includes('web_search') && guestAllow.includes('web_fetch'), guestAllow.join(','))
check('访客会话注册了受限读工具（read/glob/grep）',
  ['read', 'glob', 'grep'].every((n) => guestSession.tools.includes(n)), guestSession.tools.join(','))
check('访客会话**没有**注册发图/发文件工具（只读角色）',
  !guestSession.tools.includes('qq_send_image') && !guestSession.tools.includes('qq_send_file'), guestSession.tools.join(','))
check('访客会话注册了只读查询工具（成员/历史）',
  guestSession.tools.includes('qq_member_info') && guestSession.tools.includes('qq_recent_history'), guestSession.tools.join(','))

await send(b.server, '你好', { userId: ADMIN })
const adminSession = b.built[b.built.length - 1]
check('超管会话挂完整 preset', adminSession.meta.agentPreset === 'qq-coding', String(adminSession.meta.agentPreset))
check('超管会话不做裁剪（全都要，不能因为漏列就丢掉宿主工具）', adminSession.restrict.length === 0, JSON.stringify(adminSession.restrict))
check('超管会话注册了发图/发文件工具', adminSession.tools.includes('qq_send_image') && adminSession.tools.includes('qq_send_file'), adminSession.tools.join(','))

// ===== 3. guard：可见 ≠ 可执行（真机上 restrict 会整段失效，靠它兜底） =====
check('访客会话注册了 guard（按允许集合拒绝执行）', guestSession.guards.length === 1, String(guestSession.guards.length))
const guestGuard = guestSession.guards[0]
if (guestGuard) {
  check('guard 放行已授权的工具（read / web_search）',
    guestGuard({ name: 'read' }) === undefined && guestGuard({ name: 'web_search' }) === undefined)
  check('guard 拒绝未授权的宿主级工具（ecs_exec / session_read / bash）',
    [ 'ecs_exec', 'n8n_status', 'gh_run_list', 'session_read', 'context_handoff', 'bash', 'write' ]
      .every((name) => typeof guestGuard({ name }) === 'string'), String(guestGuard({ name: 'ecs_exec' })))
  check('guard 拒绝理由里写清是哪个主体', String(guestGuard({ name: 'ecs_exec' })).includes('group:2001'), String(guestGuard({ name: 'ecs_exec' })))
  check('guard 对没有名字的调用不插手', guestGuard({}) === undefined && guestGuard(undefined) === undefined)
}
check('超管会话不注册 guard（全都要，别误伤）', adminSession.guards.length === 0, String(adminSession.guards.length))

b.bridge.stop()
rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
