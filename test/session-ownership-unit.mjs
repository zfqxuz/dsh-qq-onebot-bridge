/**
 * 工作区切换（本地补丁）验收测试。
 *
 * 覆盖需求：
 *  - /ws 列表 / 切换 / 退出，只对 owner 开放（guest 被拒）；
 *  - 切换后进入「该工作区最新会话」（按会话文件 mtime 取最新）；
 *  - 切换后 assistant 的输出仍然发回当前 QQ 会话；
 *  - /ws off 回到本聊天原来的会话（绑定期间不污染 qq-sessions.json）；
 *  - 没有会话的工作区：下一条消息按该工作区新建。
 *
 * 用环境变量把 DSH 会话根与工作区登记表指到临时目录，不碰真实 ~/.dsh。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-workspace-test-'))
const sessionRoot = join(root, 'sessions')
const registryFile = join(root, 'storages', 'workspace.json')
const stateDir = join(root, 'state')
const wsA = join(root, 'wsA')
const wsB = join(root, 'wsB')
mkdirSync(stateDir, { recursive: true })
mkdirSync(wsA, { recursive: true })
mkdirSync(wsB, { recursive: true })
process.env.QQ_WORKSPACE_SESSION_ROOT = sessionRoot
process.env.QQ_WORKSPACE_REGISTRY = registryFile

/** 与 bridge.js 里的 workspaceProjectKey() 同源的最小编码（测试独立实现，防止同源假绿）。 */
function projectKey(cwd) {
  let readable = ''
  let sep = false
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sep) readable += '-'
      sep = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      sep = false
    } else {
      readable += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      sep = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

const ID_OLD = 'session-11111111-1111-4111-8111-111111111111'
const ID_NEW = 'session-22222222-2222-4222-8222-222222222222'

/** 造一条假会话目录：session.* 文件的 mtime 决定"最新"。 */
function makeSession(wsPath, id, atMs) {
  const dir = join(sessionRoot, projectKey(wsPath), id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, 'session')
  writeFileSync(join(dir, 'session.lock'), '')
  utimesSync(file, atMs / 1000, atMs / 1000)
  utimesSync(dir, atMs / 1000, atMs / 1000)
}

const now = Date.now()
makeSession(wsA, ID_OLD, now - 3_600_000)
makeSession(wsA, ID_NEW, now - 60_000)
// wsB 故意一条会话都没有（验证「新建一条」分支）
mkdirSync(registryFile.replace(/\/[^/]+$/, ''), { recursive: true })
writeFileSync(registryFile, JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  tables: {
    workspaces: {
      aaaa: { path: wsA, title: 'wsA', sessionIds: [ID_OLD, ID_NEW] },
      bbbb: { path: wsB, title: 'wsB', sessionIds: [] },
    },
  },
}))

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
    const record = { sessionId: String(sessionId), meta: options.meta ?? {}, sections: [], tools: [], followups: [] }
    const agentCtx = {
      systemPrompt: { section: (section) => record.sections.push(section) },
      tools: { register: (tool) => record.tools.push(tool) },
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
    const handle = { agent, dispose: async () => {} }
    built.push(record)
    return handle
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

const config = Config({
  cwd: stateDir,
  allowUsers: [1001, 1002],
  acceptPrivate: true,
  botQq: 999,
  adminEnabled: false,
  sessionResumeEnabled: true,
  historyArchiveEnabled: false,
  memoryEnabled: false,
  identity: {
    enabled: true,
    map: { 1001: 'owner' },
    defaultRole: 'guest',
    groupRole: 'guest',
    roles: {
      owner: { preset: 'qq-coding', cwd: stateDir },
      guest: { preset: 'qq-readonly', cwd: join(root, 'guest') },
    },
  },
})

const server = new MockServer()
const { ctx, built } = makeCtx()
const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
bridge.start()

let seq = 0
async function send(text, userId = 1001, waitMs = 400) {
  const before = server.sent.length
  server.emit('message', {
    bot: server.socket,
    userId,
    messageType: 'private',
    groupId: 0,
    text,
    atMe: false,
    ats: [],
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

const bindingFile = join(stateDir, 'qq-workspaces.json')
const readBinding = (key) => {
  if (!existsSync(bindingFile)) return null
  return JSON.parse(readFileSync(bindingFile, 'utf8'))[key] ?? null
}


// ===========================================================================
// 会话所有权（阶段 2）：启动占位 + 永不 fork
// ===========================================================================

/** 造一个"宿主重启后"的新桥实例：ctx 可注入 resume 行为。 */
function makeCtx2({ resumeError = null } = {}) {
  const base = makeCtx()
  const resumeCalls = []
  const createCalls = []
  // 允许测试直接派发自定义事件（迁移契约），并记录桥接广播出去的事件。
  const myHandlers = new Map()
  const emitted = []
  const origOn = base.ctx.on
  base.ctx.on = (name, handler) => {
    const list = myHandlers.get(name) ?? []
    list.push(handler)
    myHandlers.set(name, list)
    return origOn(name, handler)
  }
  base.ctx.emit = (name, payload) => {
    emitted.push([name, payload])
    for (const handler of myHandlers.get(name) ?? []) handler(payload)
  }
  const emitCustom = (name, payload) => {
    for (const handler of myHandlers.get(name) ?? []) handler(payload)
  }
  const origCreate = base.ctx.agents.create
  base.ctx.agents = {
    create: async (options) => { createCalls.push(String(options.sessionId)); return origCreate(options) },
    resume: async (options) => {
      resumeCalls.push(String(options.resumeSessionId))
      if (resumeError !== null) throw resumeError
      const built = await makeCtxResume(options)
      return built
    },
  }
  // resume 成功时复用 makeCtx 里的 build 逻辑
  async function makeCtxResume(options) {
    const record = { sessionId: String(options.resumeSessionId), meta: options.meta ?? {}, sections: [], tools: [], followups: [] }
    const agentCtx = {
      systemPrompt: { section: (section) => record.sections.push(section) },
      tools: { register: (tool) => record.tools.push(tool) },
    }
    if (options.setup) await options.setup(agentCtx)
    const agent = {
      id: String(options.resumeSessionId), status: 'idle',
      followup: (message) => { record.followups.push((message.content ?? []).map((b) => b.text ?? '').join('')) },
      cancel: () => {},
    }
    base.built.push(record)
    return { agent, dispose: async () => {} }
  }
  return { ctx: base.ctx, built: base.built, resumeCalls, createCalls, emitted, emitCustom }
}

const sessionStoreFile = join(stateDir, 'qq-sessions.json')
const readStored = (key) => {
  if (!existsSync(sessionStoreFile)) return null
  return JSON.parse(readFileSync(sessionStoreFile, 'utf8'))[key] ?? null
}

// --- 0. 先用第一个桥建立绑定会话（模拟"重启前"的状态）---
const firstReply = await send('第一条消息')
check('前置：第一条消息得到回复', firstReply.includes('（回复）'), firstReply.trim().slice(0, 60))

// --- 1. 拿到"已绑定"的 sessionId ---
const boundSessionId = readStored('u:1001') ?? built[0].sessionId
check('前置：u:1001 已有绑定会话', typeof boundSessionId === 'string' && boundSessionId.length > 0, boundSessionId)

// --- 2. 永不 fork：宿主重启后会话被别人占用 ---
const owned = Object.assign(new Error(`session "${boundSessionId}" is already owned by an active write handle`), { name: 'SessionAlreadyOwnedError' })
const w2 = makeCtx2({ resumeError: owned })
const server2 = new MockServer()
const config2 = Config({
  cwd: stateDir, allowUsers: [1001], acceptPrivate: true, botQq: 999, adminEnabled: false,
  sessionResumeEnabled: true, historyArchiveEnabled: false, memoryEnabled: false,
  sessionClaimRetries: 0, preclaimSessions: false,
  identity: { enabled: true, map: { 1001: 'owner' }, defaultRole: 'guest', groupRole: 'guest',
    roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly', cwd: join(root, 'guest') } } },
})
const bridge2 = new QQBridge(w2.ctx, config2, server2, { info() {}, warn() {}, error() {} })
bridge2.start()
let seq2 = 0
server2.emit('message', {
  bot: server2.socket, userId: 1001, messageType: 'private', groupId: 0, text: '还在吗', atMe: false,
  ats: [], reply: null, records: [], images: [], files: [], messageId: `n${++seq2}`, senderName: 'tester', raw: { message: [] },
})
await new Promise((r) => setTimeout(r, 500))
const reply2 = server2.sent.map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
check('会话被占用时不新建会话（永不 fork）', w2.createCalls.length === 0, `createCalls=${JSON.stringify(w2.createCalls)}`)
check('会话被占用时给出人话提示', reply2.includes('占用'), reply2.trim().slice(0, 120))
check('会话被占用时绑定保持不变', readStored('u:1001') === boundSessionId, String(readStored('u:1001')))

// --- 3. 启动占位：宿主启动时先把绑定会话抢下来 ---
const w3 = makeCtx2()
const server3 = new MockServer()
const config3 = Config({
  cwd: stateDir, allowUsers: [1001], acceptPrivate: true, botQq: 999, adminEnabled: false,
  sessionResumeEnabled: true, historyArchiveEnabled: false, memoryEnabled: false, preclaimSessions: true,
  identity: { enabled: true, map: { 1001: 'owner' }, defaultRole: 'guest', groupRole: 'guest',
    roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly', cwd: join(root, 'guest') } } },
})
const bridge3 = new QQBridge(w3.ctx, config3, server3, { info() {}, warn() {}, error() {} })
bridge3.start()
await new Promise((r) => setTimeout(r, 400))
check('启动占位续接了绑定会话', w3.resumeCalls.includes(boundSessionId), `resumeCalls=${JSON.stringify(w3.resumeCalls)}`)
check('启动占位不新建会话', w3.createCalls.length === 0, `createCalls=${JSON.stringify(w3.createCalls)}`)

// --- 4. 迁移契约：桥接认领并自建接续会话 ---
const w4 = makeCtx2()
const server4 = new MockServer()
const config4 = Config({
  cwd: stateDir, allowUsers: [1001], acceptPrivate: true, botQq: 999, adminEnabled: false,
  sessionResumeEnabled: true, historyArchiveEnabled: false, memoryEnabled: false,
  preclaimSessions: false, claimSessionTransfer: true,
  identity: { enabled: true, map: { 1001: 'owner' }, defaultRole: 'guest', groupRole: 'guest',
    roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly', cwd: join(root, 'guest') } } },
})
const bridge4 = new QQBridge(w4.ctx, config4, server4, { info() {}, warn() {}, error() {} })
bridge4.start()
w4.emitCustom('context-handoff/requested', {
  fromSessionId: boundSessionId, cwd: stateDir, reason: 'test',
  digest: '【上一会话摘要】继续 T3 验收', availableRatio: 0.1, used: 900, contextWindow: 1000, deadlineMs: 2000,
})
await new Promise((r) => setTimeout(r, 600))
const afterTransfer = readStored('u:1001')
check('认领后由桥接自建了接续会话', w4.createCalls.length === 1, `createCalls=${JSON.stringify(w4.createCalls)}`)
check('绑定事务化切到新会话', afterTransfer !== boundSessionId && afterTransfer === w4.createCalls[0], `after=${afterTransfer}`)
check('广播了 claimed 与 committed',
  w4.emitted.some((e) => e[0] === 'context-handoff/claimed') && w4.emitted.some((e) => e[0] === 'context-handoff/committed'),
  JSON.stringify(w4.emitted.map((e) => e[0])))
check('新会话收到 recall 摘要', (w4.built.at(-1)?.followups ?? []).join('').includes('上一会话摘要'),
  JSON.stringify((w4.built.at(-1)?.followups ?? []).map((t) => t.slice(0, 24))))
check('QQ 收到交接提示', server4.sent.map((i) => i.segments.map((x) => x.data?.text ?? '').join('')).join('\n').includes('交接'),
  server4.sent.length + ' 条')

// --- 5. 启动对账：沿 header.parentSession 跟到 handoff 子会话 ---
const CHILD_ID = 'session-33333333-3333-4333-8333-333333333333'
{
  const dir = join(sessionRoot, projectKey(stateDir), CHILD_ID)
  mkdirSync(dir, { recursive: true })
  const header = {
    type: 'session', version: 4, id: CHILD_ID, createdAt: Date.now(), cwd: stateDir,
    parentSession: afterTransfer, isSeeded: false, delegationDepth: 0, agentPreset: 'qq-coding',
  }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')))
  writeFileSync(join(dir, 'session.lock'), '')
}
const w5 = makeCtx2()
const server5 = new MockServer()
const config5 = Config({
  cwd: stateDir, allowUsers: [1001], acceptPrivate: true, botQq: 999, adminEnabled: false,
  sessionResumeEnabled: true, historyArchiveEnabled: false, memoryEnabled: false,
  preclaimSessions: false, reconcileSessions: true,
  identity: { enabled: true, map: { 1001: 'owner' }, defaultRole: 'guest', groupRole: 'guest',
    roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly', cwd: join(root, 'guest') } } },
})
const bridge5 = new QQBridge(w5.ctx, config5, server5, { info() {}, warn() {}, error() {} })
bridge5.start()
await new Promise((r) => setTimeout(r, 500))
check('启动对账跟到 handoff 子会话', readStored('u:1001') === CHILD_ID, `bound=${readStored('u:1001')}`)
check('对账不新建会话', w5.createCalls.length === 0, `createCalls=${JSON.stringify(w5.createCalls)}`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
