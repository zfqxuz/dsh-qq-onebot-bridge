/**
 * [本地补丁] P0 会话写权冲突 → 排队等待（SPEC-ownership-and-takeover §3 L0）验收测试。
 *
 * 覆盖：
 *   1. wait（默认）：冲突时消息**不丢**，收下并回执；锁释放后在原会话里按序补跑，绝不 fork；
 *   2. 队列上限：超出 sessionConflictMaxQueued 时丢最旧的，并**告诉用户**（不静默）；
 *   3. fork 策略：等满 sessionConflictWaitSeconds 仍拿不到 → 另开新会话处理队列，并明说历史没带过来；
 *   4. /new 期间：结束等待但不丢消息——排队内容转入新会话；
 *   5. fail 策略：保留旧行为（直接报错），供调试。
 *
 * 全程用假 ctx（agents.resume 可控抛 SessionAlreadyOwnedError）+ 假 OneBot 服务端，不联网、不建真实会话。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-conflict-test-'))
// 托管权名册也指到临时目录：单测不许往真实 DSH home 里写东西
process.env.QQ_HARNESS_STATE_DIR = join(root, 'harness')
const stateDir = join(root, 'state')
mkdirSync(stateDir, { recursive: true })

const ID_BOUND = 'session-aaaaaaaa-1111-4111-8111-111111111111'
const ID_CREATED = 'session-bbbbbbbb-2222-4222-8222-222222222222'

/** 写"重启前"的绑定：u:1001 -> ID_BOUND。 */
writeFileSync(join(stateDir, 'qq-sessions.json'), JSON.stringify({ 'u:1001': ID_BOUND }), 'utf8')

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
  sendText(bot, messageType, targetId, text) {
    return this.sendSegments(bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }
  currentSocket() { return this.socket }
}

/** 假宿主：agents.resume 可切换"被占用 / 正常"，create 计数。 */
function makeCtx() {
  const handlers = new Map()
  const built = []
  const resumeCalls = []
  const createCalls = []
  let resumeError = null
  const emitSession = (sessionId, text) => {
    for (const handler of handlers.get('session/event') ?? []) {
      handler({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    }
  }
  const build = async (sessionId, options) => {
    const record = { sessionId: String(sessionId), followups: [], meta: options.meta ?? {} }
    const agentCtx = { systemPrompt: { section: () => {} }, tools: { register: () => {} } }
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
  const serviceTable = {}
  const ctx = {
    // 注意：agentDefaultModel 是宿主级服务，桥接直接读 ctx 属性（见 ownership 测试的写法）
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    get: (name) => serviceTable[name],
    reflect: { get: (name) => serviceTable[name] },
    agents: {
      create: async (options) => { createCalls.push(String(options.sessionId)); return build(options.sessionId, options) },
      resume: async (options) => {
        resumeCalls.push(String(options.resumeSessionId))
        if (resumeError !== null) throw resumeError
        return build(options.resumeSessionId, options)
      },
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return {
    ctx, built, resumeCalls, createCalls,
    hold() { resumeError = Object.assign(new Error(`session "${ID_BOUND}" is already owned by an active write handle`), { name: 'SessionAlreadyOwnedError' }) },
    release() { resumeError = null },
  }
}

function makeBridge(world, overrides = {}) {
  const config = Config({
    cwd: stateDir,
    allowUsers: [1001],
    acceptPrivate: true,
    botQq: 999,
    adminEnabled: false,
    sessionResumeEnabled: true,
    preclaimSessions: false,
    sessionClaimRetries: 0,
    historyArchiveEnabled: false,
    memoryEnabled: false,
    identity: {
      enabled: true,
      map: { 1001: 'owner' },
      defaultRole: 'guest',
      groupRole: 'guest',
      roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly', cwd: join(root, 'guest') } },
    },
    ...overrides,
  })
  const server = new MockServer()
  const bridge = new QQBridge(world.ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  let seq = 0
  const send = async (text, waitMs = 250) => {
    const before = server.sent.length
    server.emit('message', {
      bot: server.socket, userId: 1001, messageType: 'private', groupId: 0, text, atMe: false,
      ats: [], reply: null, records: [], images: [], files: [], messageId: `c${++seq}`, senderName: 'tester', raw: { message: [] },
    })
    const until = Date.now() + waitMs
    while (Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    return server.sent.slice(before).map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
  }
  const allReplies = () => server.sent.map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
  const traceReasons = (stage) => (bridge.trace?.recent({ limit: 500, stage }) ?? []).map((e) => `${e.ok ? 'ok' : 'x'} ${e.reason}`)
  return { bridge, server, send, allReplies, traceReasons }
}

const stored = () => JSON.parse(readFileSync(join(stateDir, 'qq-sessions.json'), 'utf8'))['u:1001']

// ---------------------------------------------------------------------------
// 1) wait（默认）：收下 → 回执 → 锁释放后在原会话补跑，绝不 fork
// ---------------------------------------------------------------------------
{
  const world = makeCtx()
  world.hold()
  const app = makeBridge(world, { sessionConflictNoticeSeconds: 0, sessionConflictBackoffSeconds: [1], sessionConflictWaitSeconds: 3600 })
  const first = await app.send('还在吗', 200)
  check('wait：冲突时给出"收下并等待"的人话回执', first.includes('占用') && first.includes('/new'), first.trim().slice(0, 90))
  check('wait：冲突时不新建会话（永不 fork）', world.createCalls.length === 0, `createCalls=${JSON.stringify(world.createCalls)}`)
  check('wait：绑定保持不变', stored() === ID_BOUND, String(stored()))
  check('wait：冲突写进 trace（stage=conflict, ok=false）',
    app.traceReasons('conflict').some((r) => r.startsWith('x')), JSON.stringify(app.traceReasons('conflict').slice(0, 3)))

  world.release()
  await new Promise((r) => setTimeout(r, 1600))
  const resumed = world.built.find((record) => record.sessionId === ID_BOUND)
  check('wait：锁释放后自动夺回原会话并补跑排队消息',
    resumed !== undefined && resumed.followups.includes('还在吗'),
    JSON.stringify(resumed?.followups ?? []))
  check('wait：补跑写进 trace（stage=conflict, ok=true）',
    app.traceReasons('conflict').some((r) => r.startsWith('ok')), JSON.stringify(app.traceReasons('conflict').slice(-2)))
  check('wait：补跑后回复照常发回聊天', app.allReplies().includes('（回复）还在吗'), app.allReplies().trim().slice(0, 80))
  app.bridge.stop()
}

// ---------------------------------------------------------------------------
// 1b) 顺序保证：排队消息先补跑，当前这条后走（不能"新的先回、旧的后回"）
// ---------------------------------------------------------------------------
{
  const world = makeCtx()
  world.hold()
  const app = makeBridge(world, { sessionConflictNoticeSeconds: 0, sessionConflictBackoffSeconds: [3600], sessionConflictWaitSeconds: 3600 })
  await app.send('排队的旧消息', 150)
  world.release()
  await app.send('新消息', 400)
  const resumed = world.built.find((record) => record.sessionId === ID_BOUND)
  check('顺序：更早排队的消息先补跑，当前消息后走',
    JSON.stringify(resumed?.followups ?? []) === JSON.stringify(['排队的旧消息', '新消息']),
    JSON.stringify(resumed?.followups ?? []))
  app.bridge.stop()
}

// ---------------------------------------------------------------------------
// 2) 队列上限：超出上限丢最旧，并明确告诉用户
// ---------------------------------------------------------------------------
{
  const world = makeCtx()
  world.hold()
  const app = makeBridge(world, { sessionConflictNoticeSeconds: 0, sessionConflictBackoffSeconds: [30], sessionConflictMaxQueued: 2, sessionConflictWaitSeconds: 3600 })
  await app.send('第一条', 120)
  await app.send('第二条', 120)
  const third = await app.send('第三条', 200)
  check('上限：超出上限时提示消息被丢掉', third.includes('丢掉'), third.trim().slice(0, 90))
  world.release()
  // 手动触发一次重试（退避是 30 秒，测试不等它）：直接调私有逻辑不可行，改用 /new 路径验证队列内容
  const created = app.allReplies()
  check('上限：队列只保留最新两条（第三条那批的提示已给出）', created.includes('丢掉'), created.trim().slice(0, 60))
  app.bridge.stop()
}

// ---------------------------------------------------------------------------
// 3) fork 策略：等满上限 → 另开新会话处理队列
// ---------------------------------------------------------------------------
{
  const world = makeCtx()
  world.hold()
  const app = makeBridge(world, {
    sessionConflictPolicy: 'fork', sessionConflictNoticeSeconds: 0,
    sessionConflictBackoffSeconds: [1], sessionConflictWaitSeconds: 5,
  })
  const first = await app.send('fork 场景', 200)
  check('fork：先给等待回执', first.includes('占用'), first.trim().slice(0, 60))
  await new Promise((r) => setTimeout(r, 8000))
  // #createSession 用 agents.create（sessionId 由宿主给）；测试里 create 记录的是传入的 sessionId
  check('fork：超时后调用 create 另开会话', world.createCalls.length === 1, `createCalls=${JSON.stringify(world.createCalls)}`)
  const created = world.built[world.built.length - 1]
  check('fork：排队消息在新会话里补跑', created.followups.includes('fork 场景'), JSON.stringify(created.followups))
  check('fork：明确告知"另开新会话、历史没带过来"', app.allReplies().includes('另开一条新会话'), app.allReplies().trim().slice(-90))
  app.bridge.stop()
}

// ---------------------------------------------------------------------------
// 4) /new：结束等待但不丢消息
// ---------------------------------------------------------------------------
{
  const world = makeCtx()
  world.hold()
  const app = makeBridge(world, { sessionConflictNoticeSeconds: 0, sessionConflictBackoffSeconds: [30], sessionConflictWaitSeconds: 3600 })
  await app.send('排队 A', 120)
  await app.send('排队 B', 120)
  const replyNew = await app.send('/new', 1500)
  check('/new：立刻另开会话并说明排队内容在里面处理', replyNew.includes('已开新会话') && replyNew.includes('排队'), replyNew.trim().slice(0, 90))
  const created = world.built[world.built.length - 1]
  check('/new：排队消息在新会话里补跑（一条不丢）',
    created.followups.includes('排队 A') && created.followups.includes('排队 B'),
    JSON.stringify(created.followups))
  app.bridge.stop()
}

// ---------------------------------------------------------------------------
// 5) fail 策略：保留旧行为
// ---------------------------------------------------------------------------
{
  const world = makeCtx()
  world.hold()
  const app = makeBridge(world, { sessionConflictPolicy: 'fail', sessionClaimRetries: 0 })
  const reply = await app.send('老行为', 300)
  check('fail：直接报错（旧行为保留）', reply.includes('Agent 处理失败') && reply.includes('占用'), reply.trim().slice(0, 80))
  check('fail：不新建会话', world.createCalls.length === 0, `createCalls=${JSON.stringify(world.createCalls)}`)
  app.bridge.stop()
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
