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

// ===== 1. 先建立一个「本聊天的默认会话」 =====
const first = await send('第一条消息')
check('默认消息进入 agent 并回发 QQ', first.includes('（回复）'), first.trim())
const defaultSessionId = built[0].sessionId
check('默认会话按聊天 cwd 建立', built[0].meta.cwd === stateDir, `cwd=${built[0].meta.cwd}`)

// ===== 2. /ws 列表 =====
const listed = await send('/ws')
check('/ws 列出工作区', listed.includes('可切换的工作区') && listed.includes('wsA') && listed.includes('wsB'), listed.trim().replace(/\n/g, ' | '))
check('/ws 标出最新会话', listed.includes(ID_NEW.slice(0, 8)), listed.trim().replace(/\n/g, ' | '))

// ===== 3. 权限：guest 被拒 =====
const denied = await send('/ws wsA', 1002)
check('guest 切工作区被拒绝', denied.includes('只对管理员开放'), denied.trim())
check('guest 被拒后没有写绑定', readBinding('u:1002') === null)

// ===== 4. owner 切换：进入 wsA 最新会话 =====
const switched = await send('/ws wsA')
check('切换成功提示', switched.includes('已切到工作区：wsA') && switched.includes(ID_NEW.slice(0, 8)), switched.trim().replace(/\n/g, ' | '))
check('绑定已落盘', readBinding('u:1001')?.path === wsA, JSON.stringify(readBinding('u:1001')))

const worked = await send('在工作区里干活')
const workSession = built[built.length - 1]
check('切换后进入工作区最新会话（不是旧会话）', workSession.sessionId === ID_NEW, workSession.sessionId)
check('切换后 assistant 输出仍回发 QQ', worked.includes('（回复）'), worked.trim())
check('绑定期间不覆盖 qq-sessions.json 的默认会话',
  JSON.parse(readFileSync(join(stateDir, 'qq-sessions.json'), 'utf8'))['u:1001'] === defaultSessionId,
  readFileSync(join(stateDir, 'qq-sessions.json'), 'utf8').trim())

// ===== 5. /ws off 回到原会话 =====
const off = await send('/ws off')
check('/ws off 提示', off.includes('已退出工作区 wsA'), off.trim())
check('/ws off 清掉绑定', readBinding('u:1001') === null)
const back = await send('退出后再聊')
check('退出后回到本聊天原来的会话', built[built.length - 1].sessionId === defaultSessionId, built[built.length - 1].sessionId)
check('退出后回复照常走 QQ', back.includes('（回复）'), back.trim())

// ===== 6. 没有会话的工作区：按该工作区新建 =====
const switchedB = await send('/ws wsB')
check('切到无会话工作区提示新建', switchedB.includes('还没有会话'), switchedB.trim().replace(/\n/g, ' | '))
await send('在 wsB 新建')
const bSession = built[built.length - 1]
check('无会话工作区按该工作区 cwd 新建', bSession.meta.cwd === wsB, `cwd=${bSession.meta.cwd}`)

// ===== 7. 找不到的工作区 =====
const missing = await send('/ws 不存在的名字')
check('未知工作区有明确提示', missing.includes('没找到工作区'), missing.trim())

bridge.stop()
rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
