/**
 * 群聊「@机器人 前缀」归一化验收测试（本地补丁 2026-10-09）。
 *
 * 复现的真机现象：群里 @ 机器人之后，正文是 `@2267595782 /ws`（at 段被渲染进正文），
 * 斜杠命令要求行首锚定 → 命令认不出来，整条被当成聊天丢给模型。
 *
 * 覆盖：
 *  - `@<机器人QQ> /ws` → 命令生效（不再是聊天）；
 *  - `@<机器人QQ> 你好` → 正文里的 @ 前缀被剥掉，模型看到的是 `你好`；
 *  - `@<别人QQ> /ws`（本条也 @ 了机器人）→ 仍然认命令（命令优先于 @ 语义）；
 *  - `@<别人QQ> 你好` → 原样，不误伤；
 *  - 私聊完全不受影响；
 *  - 没 @ 机器人的群消息 → 不剥（也就不会进模型，被门禁挡下）；
 *  - 命令在前、@ 在后（真机 `/status @机器人`）→ 行内自我 @ 也要剥掉，命令才认得出。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'qq-atprefix-test-'))
const stateDir = join(root, 'state')
mkdirSync(join(root, 'guest'), { recursive: true })

const BOT = 999
const OWNER = 1001
const OTHER = 1002
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
      tools: { register: () => {} },
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

const config = Config({
  cwd: stateDir,
  allowUsers: [OWNER],
  acceptPrivate: true,
  allowGroups: [GROUP],
  botQq: BOT,
  adminEnabled: false,
  sessionResumeEnabled: true,
  historyArchiveEnabled: false,
  memoryEnabled: false,
  identity: {
    enabled: true,
    map: { [OWNER]: 'owner' },
    defaultRole: 'guest',
    groupRole: 'owner',
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
async function send(text, { group = false, atMe = false, ats = [], waitMs = 600 } = {}) {
  const before = server.sent.length
  server.emit('message', {
    bot: server.socket,
    userId: OWNER,
    messageType: group ? 'group' : 'private',
    groupId: group ? GROUP : 0,
    text,
    atMe,
    ats,
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
  await new Promise((r) => setTimeout(r, 40))
  return server.sent.slice(before).map((item) => item.segments.map((s) => s.data?.text ?? `[${s.type}]`).join('')).join('\n')
}

const lastFollowup = () => built[built.length - 1]?.followups.at(-1) ?? ''

// ===== 1. 群聊 `@机器人 /ws`：命令必须生效 =====
const cmd = await send(`@${BOT} /ws`, { group: true, atMe: true, ats: [BOT] })
check('群聊 @机器人 /ws 被当成命令', cmd.includes('可切换的工作区') || cmd.includes('没读到工作区登记表'), cmd.trim().replace(/\n/g, ' | '))
check('群聊 @机器人 /ws 没有落给模型', !cmd.includes('（回复）'), cmd.trim())

// ===== 2. 群聊 `@机器人 你好`：剥掉前缀后交给模型 =====
await send(`@${BOT} 你好`, { group: true, atMe: true, ats: [BOT] })
check('群聊 @机器人 之后的正文剥掉 @ 前缀', lastFollowup() === '你好', JSON.stringify(lastFollowup()))

// ===== 3. 群聊 `@别人 /ws`（本条也 @ 了机器人）：命令优先 =====
const otherCmd = await send(`@${OTHER} /ws`, { group: true, atMe: true, ats: [OTHER, BOT] })
check('@别人 + 斜杠命令仍按命令处理', otherCmd.includes('可切换的工作区') || otherCmd.includes('没读到工作区登记表'), otherCmd.trim().replace(/\n/g, ' | '))

// ===== 4. 群聊 `@别人 你好`：不误伤 =====
await send(`@${OTHER} 你好`, { group: true, atMe: true, ats: [OTHER, BOT] })
check('普通聊天里的 @别人 原样保留', lastFollowup() === `@${OTHER} 你好`, JSON.stringify(lastFollowup()))

// ===== 5. 私聊不受影响 =====
await send('你好', { group: false })
check('私聊文本不受影响', lastFollowup() === '你好', JSON.stringify(lastFollowup()))

// ===== 6. 群聊没 @ 机器人：门禁挡下，不产生任何回复 =====
const quiet = await send(`@${BOT} /ws`, { group: true, atMe: false, ats: [] })
check('未 @ 机器人的群消息仍然静默', quiet === '', quiet.trim())

// ===== 7. 群聊「命令在前、@在后」也要认（真机 2026-10-09：/status @机器人 没被当命令） =====
const trailingStatus = await send(`/status @${BOT}`, { group: true, atMe: true, ats: [BOT] })
check('命令后面跟 @机器人 也认（/status）', trailingStatus.includes('QQ 桥状态'), trailingStatus.trim())
const trailingWs = await send(`/ws @${BOT}`, { group: true, atMe: true, ats: [BOT] })
check('命令后面跟 @机器人 也认（/ws）',
  trailingWs.includes('可切换的工作区') || trailingWs.includes('没读到工作区登记表'), trailingWs.trim())

// ===== 8. 行内/行尾的自我 @ 去掉；别人的 @ 原样保留 =====
// 断言用"回复文本"而不是 mock 的 followup 列表：第 6 节创建过私聊会话，
// built[last] 已经不是群会话那条记录了（踩过一次，写在这里防复发）。
const inline1 = await send(`继续 @${BOT}`, { group: true, atMe: true, ats: [BOT] })
check('行尾的自我 @ 被去掉', inline1 === '（回复）继续', JSON.stringify(inline1))
const inline2 = await send(`@${BOT} 你好 @${OTHER}`, { group: true, atMe: true, ats: [BOT, OTHER] })
check('别人的 @ 原样保留（只有机器人自己的被剥）', inline2 === `（回复）你好 @${OTHER}`, JSON.stringify(inline2))

bridge.stop()
rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
