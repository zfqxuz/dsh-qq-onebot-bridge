/**
 * 人格注入（本地补丁 persona）验收测试。
 *
 * 背景（2026-10-09 排障）：preset 里的 persona 插件写了 `complete: true`，DSH 会把
 * 整个 system prompt 换成那一句，桥接自己的 `qq-onebot-bridge` 规则段被静默丢掉 ——
 * 群里就只剩"我是个软件工程助手"的裸人设，表现得又端着又爱较真。
 *
 * 本测试盯住修好之后的契约：
 *  1. 每个 QQ 会话都注册独立的 `qq-persona` 段，且排在规则段（order 118）之前；
 *  2. 文本是**函数**（每次组装请求实时解析）→ 改 persona 文件下一句话就生效；
 *  3. 优先级：按会话文件 > 按会话配置 > 按角色文件 > 按角色配置 > 兜底文件 > 兜底配置 > 内置；
 *  4. extra 永远追加在人格正文之后；
 *  5. persona.enabled === false 时完全不注册（可一键回退）；
 *  6. 文件读不到 / 配置为空都不炸，逐级降级。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'qq-persona-test-'))
const stateDir = join(root, 'state')
const personaDir = join(root, 'persona')
const guestDir = join(root, 'guest')
mkdirSync(stateDir, { recursive: true })
mkdirSync(personaDir, { recursive: true })
mkdirSync(guestDir, { recursive: true })

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

/** 记录每个会话注册的 system prompt 段与工具；getSectionOrder 可选（模拟真实 DSH）。 */
function makeCtx({ withSectionOrder = true } = {}) {
  const built = []
  const build = async (sessionId, options) => {
    const record = { sessionId: String(sessionId), meta: options.meta ?? {}, sections: [], tools: [] }
    const systemPrompt = {
      section: (section) => record.sections.push(section),
      ...(withSectionOrder ? { getSectionOrder: (name) => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : undefined) } : {}),
    }
    const agentCtx = { systemPrompt, tools: { register: (tool) => record.tools.push(tool) } }
    if (options.setup) await options.setup(agentCtx)
    const agent = { id: String(sessionId), status: 'idle', followup: () => {}, cancel: () => {} }
    built.push(record)
    return { agent, dispose: async () => {} }
  }
  const ctx = {
    on: () => () => {},
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

function makeConfig(persona) {
  return Config({
    cwd: stateDir,
    allowUsers: [1001, 1002],
    allowGroups: [10001],
    acceptPrivate: true,
    botQq: 999,
    adminEnabled: false,
    sessionResumeEnabled: false,
    historyArchiveEnabled: false,
    memoryEnabled: false,
    replyOnlyWhenMentioned: true,
    identity: {
      enabled: true,
      map: { 1001: 'owner' },
      // 本文件测的是人格注入，不是主体目录策略：显式关掉逐主体目录，
      // 让"访客目录 = 配置里的 guestDir"这条断言继续成立（隔离本身见 subject-isolation-unit.mjs）。
      perSubjectDirs: false,
      defaultRole: 'guest',
      groupRole: 'guest',
      roles: {
        owner: { preset: 'qq-coding', cwd: stateDir },
        guest: { preset: 'qq-readonly', cwd: guestDir },
      },
    },
    persona,
  })
}

/** 发一条消息并等会话建好；返回最后一条 built 记录。 */
async function send(bridge, server, { text, userId = 1001, messageType = 'private', groupId = 0, atMe = false } = {}) {
  const before = server.sent.length
  server.emit('message', {
    bot: server.socket, userId, messageType, groupId, text, atMe,
    ats: [], reply: null, records: [], images: [], files: [],
    messageId: `m${Math.random().toString(36).slice(2)}`,
    senderName: 'tester', raw: { message: [] },
  })
  const deadline = Date.now() + 1500
  while (Date.now() < deadline && server.sent.length === before) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 30))
  return builtOf(bridge)
}

let lastBuilt = []
function builtOf() { return lastBuilt[lastBuilt.length - 1] }
function personaSection(record) {
  return (record?.sections ?? []).find((s) => s.name === 'qq-persona')
}
function personaText(record) {
  const section = personaSection(record)
  if (!section) return ''
  return typeof section.text === 'function' ? section.text({}) : String(section.text ?? '')
}

// 文件内容（文件优先于 profile 里的同名字段）
const FILE_OWNER = '文件版 owner 人设：私聊里可以直说技术细节。'
const FILE_GUEST = '文件版 guest 人设：群里说人话，短句。'
const FILE_EXTRA = '公共追加：不确定就说不确定，不许编造。'
writeFileSync(join(personaDir, 'owner.md'), FILE_OWNER, 'utf8')
writeFileSync(join(personaDir, 'guest.md'), FILE_GUEST, 'utf8')
writeFileSync(join(personaDir, 'extra.md'), FILE_EXTRA, 'utf8')

const CONFIG_OWNER = '配置版 owner 人设（应当被 owner.md 覆盖）'
const CONFIG_GUEST = '配置版 guest 人设（应当被 guest.md 覆盖）'
const CHAT_OVERRIDE = '本群专属人设：这个群只许玩梗，不许报技术细节。'

// ===== 1. 文件优先 + 按角色 / 按会话 / extra =====
{
  const config = makeConfig({
    enabled: true,
    dir: personaDir,
    owner: CONFIG_OWNER,
    guest: CONFIG_GUEST,
    extra: '配置版公共追加（应当被 extra.md 覆盖）',
    chats: { 'g:10001': CHAT_OVERRIDE },
  })
  const server = new MockServer()
  const { ctx, built } = makeCtx()
  lastBuilt = built
  const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()

  await send(bridge, server, { text: '私聊一句', userId: 1001 })
  const owner = built[built.length - 1]
  check('owner 会话注册了 qq-persona 段', !!personaSection(owner))
  check('owner 段排在规则段之前', (personaSection(owner)?.order ?? 999) < 118, `order=${personaSection(owner)?.order}`)
  check('owner 段文本是函数（可热更新）', typeof personaSection(owner)?.text === 'function')
  check('owner 人设：文件覆盖配置', personaText(owner).startsWith(FILE_OWNER), personaText(owner).slice(0, 40))
  check('owner 人设：extra.md 追加在正文之后', personaText(owner).includes(FILE_EXTRA) && personaText(owner).indexOf(FILE_OWNER) < personaText(owner).indexOf(FILE_EXTRA))

  await send(bridge, server, { text: '群友一句', userId: 1002 })
  const guest = built[built.length - 1]
  check('guest 会话注册了 qq-persona 段', !!personaSection(guest))
  check('guest 人设：文件覆盖配置', personaText(guest).startsWith(FILE_GUEST), personaText(guest).slice(0, 40))
  check('guest 人设带 extra', personaText(guest).includes(FILE_EXTRA))

  await send(bridge, server, { text: '@机器人 在吗', userId: 1002, messageType: 'group', groupId: 10001, atMe: true })
  const group = built[built.length - 1]
  check('群会话用的是 guest preset（cwd 为访客目录）', group?.meta?.cwd === guestDir, `cwd=${group?.meta?.cwd}`)
  check('群会话注册了 qq-persona 段', !!personaSection(group))
  check('按会话覆盖优先于按角色文件', personaText(group).startsWith(CHAT_OVERRIDE), personaText(group).slice(0, 40))
  check('按会话覆盖也带 extra', personaText(group).includes(FILE_EXTRA))

  // ===== 2. 热更新：改文件后，同一会话的段文本立刻变（函数文本 + 缓存校验）=====
  writeFileSync(join(personaDir, 'guest.md'), '改过的 guest 人设。', 'utf8')
  check('改 persona 文件后同一会话即时生效', personaText(guest).startsWith('改过的 guest 人设。'), personaText(guest).slice(0, 30))
  // 复原，避免影响后面的用例
  writeFileSync(join(personaDir, 'guest.md'), FILE_GUEST, 'utf8')

  // ===== 3. 按会话文件优先于按会话配置 =====
  writeFileSync(join(personaDir, 'chat-g_10001.md'), '本群专属文件人设。', 'utf8')
  check('按会话文件优先于按会话配置', personaText(group).startsWith('本群专属文件人设。'), personaText(group).slice(0, 30))

  bridge.stop()
}

// ===== 4. 没有 persona 配置：兜底内置人设，仍然注册 =====
{
  const server = new MockServer()
  const { ctx, built } = makeCtx()
  lastBuilt = built
  const bridge = new QQBridge(ctx, makeConfig(undefined), server, { info() {}, warn() {}, error() {} })
  bridge.start()
  await send(bridge, server, { text: '没配人设', userId: 1001 })
  const owner = built[built.length - 1]
  check('未配置 persona 也注册段（内置兜底）', personaText(owner) === 'You are a helpful assistant.', JSON.stringify(personaText(owner)))
  bridge.stop()
}

// ===== 5. 目录不存在 / 配置为空：逐级降级不炸 =====
{
  const server = new MockServer()
  const { ctx, built } = makeCtx({ withSectionOrder: false })
  lastBuilt = built
  const bridge = new QQBridge(ctx, makeConfig({ enabled: true, dir: join(root, '不存在的目录'), guest: '降级到配置版 guest' }), server, { info() {}, warn() {}, error() {} })
  bridge.start()
  await send(bridge, server, { text: '目录不存在时', userId: 1002 })
  const guest = built[built.length - 1]
  check('目录不存在时降级到配置文本', personaText(guest) === '降级到配置版 guest', personaText(guest))
  check('没有 getSectionOrder 时用兜底顺序', personaSection(guest)?.order === 0.5, `order=${personaSection(guest)?.order}`)
  bridge.stop()
}

// ===== 6. enabled: false：完全不注册（一键回退）=====
{
  const server = new MockServer()
  const { ctx, built } = makeCtx()
  lastBuilt = built
  const bridge = new QQBridge(ctx, makeConfig({ enabled: false, guest: '不该出现的人设', owner: '不该出现的人设' }), server, { info() {}, warn() {}, error() {} })
  bridge.start()
  await send(bridge, server, { text: '回退模式', userId: 1001 })
  const owner = built[built.length - 1]
  check('enabled:false 不注册 qq-persona', !personaSection(owner))
  check('enabled:false 时规则段照旧注册', owner.sections.some((s) => s.name === 'qq-onebot-bridge'))
  bridge.stop()
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
