/**
 * 主体隔离测试（SPEC-rbac-console.md D-2）：guest 只能看/读自己那个主体的目录。
 *
 * 复现的真实缺陷：所有 guest 共用一个 `qq-users/qqguest` 目录 → guest A 能读 guest B 的文件、
 * 群 A 能读群 B 的文件。修法：guest 的会话 cwd（= 会话工作目录 = 受限读工具根 = 可发送文件根）
 * 按主体派生：`subjects/g<群号>`、`subjects/u<QQ号>`。
 *
 * 覆盖：
 *  - 群 A / 群 B / 私聊用户 三者拿到三个不同目录；
 *  - 目录落在数据根的 subjects/ 下，且形状是 g<gid> / u<qq>；
 *  - 同一个群两次发言拿到同一个目录（会话复用，不会漂移）；
 *  - owner（超管）不受影响，仍是自己的 cwd；
 *  - `identity.perSubjectDirs: false` → 退回旧行为（共享 guest 目录）；
 *  - 受限读插件路径解析：候选列表按顺序、取第一个存在的；一个都没有时返回空串（fail-closed）。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'
import { localPluginCandidates, pickExistingFile, subjectDir } from '../lib/paths.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-subject-test-'))
const stateDir = join(root, 'state')
const dataRoot = join(root, 'data')
mkdirSync(stateDir, { recursive: true })
mkdirSync(dataRoot, { recursive: true })

const BOT = 999
const OWNER = 1001
const GUEST_USER = 1002
const GROUP_A = 2001
const GROUP_B = 2002

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
    const record = { sessionId: String(sessionId), meta: options.meta ?? {}, tools: [], followups: [] }
    const agentCtx = {
      systemPrompt: { section: () => {} },
      tools: {
        register: (tool) => record.tools.push(tool),
        restrict: () => {},
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

function makeBridge(identityExtra = {}) {
  const config = Config({
    cwd: stateDir,
    dataRoot,
    allowUsers: [OWNER, GUEST_USER],
    acceptPrivate: true,
    allowGroups: [GROUP_A, GROUP_B],
    botQq: BOT,
    adminEnabled: false,
    sessionResumeEnabled: true,
    historyArchiveEnabled: false,
    memoryEnabled: false,
    identity: {
      enabled: true,
      map: { [OWNER]: 'owner' },
      defaultRole: 'guest',
      groupRole: 'guest',
      roles: {
        owner: { preset: 'qq-coding', cwd: stateDir },
        guest: { preset: 'qq-readonly' },
      },
      ...identityExtra,
    },
  })
  const server = new MockServer()
  const { ctx, built } = makeCtx()
  const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  return { bridge, server, built, config }
}

let seq = 0
async function send(server, { userId = OWNER, groupId = 0, text = '你好', waitMs = 500 } = {}) {
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

// ===== 1. 路径工具本身 =====
check('subjectDir: 群 → subjects/g<gid>', subjectDir({ dataRoot }, `group:${GROUP_A}`) === join(dataRoot, 'subjects', `g${GROUP_A}`))
check('subjectDir: 用户 → subjects/u<qq>', subjectDir({ dataRoot }, `user:${GUEST_USER}`) === join(dataRoot, 'subjects', `u${GUEST_USER}`))
check('群 A 与群 B 的目录不同', subjectDir({ dataRoot }, `group:${GROUP_A}`) !== subjectDir({ dataRoot }, `group:${GROUP_B}`))

const candidates = localPluginCandidates('dsh-tool-fs-jailed', { repoRoot: '/repo', cwd: '/cwd' })
check('受限读插件候选包含"本机 dev/dsh-plugins"位置',
  candidates.includes(join('/repo', '..', 'dsh-plugins', 'dsh-tool-fs-jailed', 'index.js')), candidates.join(' | '))
check('受限读插件候选包含历史工作区位置',
  candidates.includes('/cwd/qq/plugins/dsh-tool-fs-jailed/index.js'))
check('pickExistingFile 取第一个存在的', (() => {
  const now = pickExistingFile(['/nope/a.js', '/tmp/subject-probe.js'], (f) => f === '/tmp/subject-probe.js')
  return now === '/tmp/subject-probe.js'
})())
check('pickExistingFile 一个都没有 → 空串（fail-closed）', pickExistingFile(['/nope/a.js'], () => false) === '')

// ===== 2. 逐主体目录（默认开启） =====
const a = makeBridge()
const replyA = await send(a.server, { groupId: GROUP_A })
check('群 A 有人说话 → 建了会话并回复', replyA.includes('（回复）'), replyA.trim())
const groupASession = a.built[a.built.length - 1]
check('群 A 的会话 cwd = subjects/g<群A>',
  groupASession.meta.cwd === join(dataRoot, 'subjects', `g${GROUP_A}`), String(groupASession.meta.cwd))

await send(a.server, { groupId: GROUP_B })
const groupBSession = a.built[a.built.length - 1]
check('群 B 的会话 cwd = subjects/g<群B>',
  groupBSession.meta.cwd === join(dataRoot, 'subjects', `g${GROUP_B}`), String(groupBSession.meta.cwd))
check('群 A 与群 B 的会话目录不同（群之间不互相可读）',
  groupASession.meta.cwd !== groupBSession.meta.cwd)

await send(a.server, { userId: GUEST_USER })
const guestPrivate = a.built[a.built.length - 1]
check('访客私聊 cwd = subjects/u<QQ>',
  guestPrivate.meta.cwd === join(dataRoot, 'subjects', `u${GUEST_USER}`), String(guestPrivate.meta.cwd))
check('私聊访客目录与群目录不同（跨主体不互相可读）',
  guestPrivate.meta.cwd !== groupASession.meta.cwd && guestPrivate.meta.cwd !== groupBSession.meta.cwd)

const beforeRepeat = a.built.length
await send(a.server, { groupId: GROUP_A, text: '再说一句' })
check('同一个群第二次发言复用同一条会话（不会另建、目录不漂移）',
  a.built.length === beforeRepeat && a.built.includes(groupASession),
  `built=${a.built.length} before=${beforeRepeat}`)

await send(a.server, { userId: OWNER })
check('owner（超管）仍然是自己的工作目录，不受主体目录影响',
  a.built[a.built.length - 1].meta.cwd === stateDir, String(a.built[a.built.length - 1].meta.cwd))
a.bridge.stop()

// ===== 3. 关掉逐主体目录 → 旧行为 =====
const sharedDir = join(root, 'shared-guest-dir')
mkdirSync(sharedDir, { recursive: true })
const b2 = makeBridge({ perSubjectDirs: false, roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly', cwd: sharedDir } } })
await send(b2.server, { groupId: GROUP_A })
check('perSubjectDirs:false → 回到配置里的共享 guest 目录',
  b2.built[b2.built.length - 1].meta.cwd === sharedDir, String(b2.built[b2.built.length - 1].meta.cwd))
b2.bridge.stop()

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
