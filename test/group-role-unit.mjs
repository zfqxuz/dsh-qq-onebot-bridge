/**
 * 开发群（按群指定角色 identity.groupRoles）验收测试。
 *
 * 背景：用户要一个"开发群"——群里所有人拥有与主人私聊相同的权限（shell + 写文件）。
 * 因为一个群共享同一条会话，角色只能按群定，所以 `groupRoles: { "<群号>": owner }`
 * 的实际含义是"整群升级为 owner"。
 *
 * 本测试盯住：
 *  1. 白名单里的群号配 owner → 该群用 qq-coding preset、owner 的 cwd、danger-full-access；
 *  2. 没配的群仍然 guest（qq-readonly + 访客 cwd + 不加 permission preset）；
 *  3. 私聊角色映射不受影响（owner 仍是 owner、访客仍是访客）；
 *  4. fail-closed：认不出的角色名（true/数字/乱写）一律按 guest，绝不意外提权；
 *     注意 admin/owner 现在是**合法**角色（D-11：admin = 唯一超管，owner 是它的历史别名），
 *  5. 群号写数字或字符串都能对上；
 *  6. 开发群里**不**施加 guest 限制（不调 tools.restrict），普通群照旧限制；
 *  7. 启动时打一条醒目的"开发群已启用"警告（可审计）。
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

const root = mkdtempSync(join(tmpdir(), 'qq-group-role-test-'))
const stateDir = join(root, 'state')
const guestDir = join(root, 'qq-users', 'qqguest')
mkdirSync(stateDir, { recursive: true })
mkdirSync(guestDir, { recursive: true })

const DEV_GROUP = 176628359        // 用户指定：开发群
const OTHER_GROUP = 134993546      // 普通群：必须保持只读

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

/** 记录每个会话的 meta / sections / tools / permissionPresets / restrict 调用。 */
function makeCtx() {
  const built = []
  const permissionCalls = []
  const warnLogs = []
  const build = async (sessionId, options) => {
    const record = { sessionId: String(sessionId), meta: options.meta ?? {}, sections: [], tools: [], restricted: false }
    const agentCtx = {
      systemPrompt: { section: (s) => record.sections.push(s), getSectionOrder: () => 0 },
      tools: { register: (t) => record.tools.push(t), restrict: () => { record.restricted = true } },
    }
    if (options.setup) await options.setup(agentCtx)
    const agent = { id: String(sessionId), session: { id: String(sessionId) }, status: 'idle', followup: () => {}, cancel: () => {} }
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
    permissionPresets: { set: (session, name) => permissionCalls.push(name) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn: (m) => warnLogs.push(String(m)), error() {} }),
  }
  return { ctx, built, permissionCalls, warnLogs }
}

function makeConfig(groupRoles) {
  return Config({
    cwd: stateDir,
    allowUsers: [1001, 1002],
    allowGroups: [DEV_GROUP, OTHER_GROUP, 999999],
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
      // 这个文件只测"角色选择"，不看主体目录策略：显式关掉逐主体目录，
      // 好让它继续断言 guestSpec.cwd（主体隔离本身在 test/subject-isolation-unit.mjs 里测）。
      perSubjectDirs: false,
      defaultRole: 'guest',
      groupRole: 'guest',
      groupRoles,
      roles: {
        owner: { preset: 'qq-coding', permission: 'danger-full-access', cwd: stateDir },
        guest: { preset: 'qq-readonly', cwd: guestDir },
      },
    },
  })
}

async function send(server, { userId = 1002, messageType = 'group', groupId = DEV_GROUP, atMe = true } = {}) {
  server.emit('message', {
    bot: server.socket, userId, messageType, groupId, atMe,
    text: '@机器人 帮我改个文件', ats: [], reply: null, records: [], images: [], files: [],
    messageId: `m${Math.random().toString(36).slice(2)}`,
    senderName: 'tester', raw: { message: [] },
  })
  await new Promise((r) => setTimeout(r, 350))
}

// ===== 1. 开发群 = owner；普通群不受影响 =====
{
  const server = new MockServer()
  const { ctx, built, permissionCalls, warnLogs } = makeCtx()
  const bridge = new QQBridge(ctx, makeConfig({ [DEV_GROUP]: 'owner' }), server, { info() {}, warn: (m) => warnLogs.push(String(m)), error() {} })
  bridge.start()

  await send(server, { groupId: DEV_GROUP })
  const dev = built[0]
  check('开发群：preset 是 owner 的 qq-coding', dev?.meta?.agentPreset === 'qq-coding', `preset=${dev?.meta?.agentPreset}`)
  check('开发群：cwd 是 owner 的工作目录', dev?.meta?.cwd === stateDir, `cwd=${dev?.meta?.cwd}`)
  check('开发群：应用了 danger-full-access', permissionCalls.includes('danger-full-access'), JSON.stringify(permissionCalls))
  check('开发群：不施加 guest 限制（不调 tools.restrict）', dev?.restricted === false)

  await send(server, { groupId: OTHER_GROUP })
  const other = built[1]
  check('普通群：仍然是 qq-readonly', other?.meta?.agentPreset === 'qq-readonly', `preset=${other?.meta?.agentPreset}`)
  check('普通群：仍然是访客 cwd', other?.meta?.cwd === guestDir, `cwd=${other?.meta?.cwd}`)
  check('普通群：施加 guest 限制', other?.restricted === true)
  check('普通群：不加 permission preset', permissionCalls.length === 1, JSON.stringify(permissionCalls))

  check('启动日志有"开发群已启用"警告', warnLogs.some((m) => m.includes('开发群已启用') && m.includes(String(DEV_GROUP))), JSON.stringify(warnLogs))

  // ===== 2. 私聊不受影响 =====
  await send(server, { userId: 1001, messageType: 'private', groupId: 0, atMe: false })
  const owner = built[2]
  check('私聊 owner 仍是 qq-coding', owner?.meta?.agentPreset === 'qq-coding', `preset=${owner?.meta?.agentPreset}`)
  await send(server, { userId: 1002, messageType: 'private', groupId: 0, atMe: false })
  const guest = built[3]
  check('私聊访客仍是 qq-readonly', guest?.meta?.agentPreset === 'qq-readonly', `preset=${guest?.meta?.agentPreset}`)

  bridge.stop()
}

// ===== 3. fail-closed：角色名写错不意外提权 =====
{
  const server = new MockServer()
  const { ctx, built, permissionCalls } = makeCtx()
  const bridge = new QQBridge(ctx, makeConfig({
    [DEV_GROUP]: 'admin',          // 不认识的角色名
    [OTHER_GROUP]: true,           // 布尔值
    999999: 'owner',               // 数字群号（应能命中，见下）
  }), server, { info() {}, warn() {}, error() {} })
  bridge.start()

  await send(server, { groupId: DEV_GROUP })
  // [权限模型 2026-10-09] admin 现在是合法角色（唯一超管，owner 是它的别名）→ 该群拿到超管能力。
  check('角色名写成 admin → 识别为超管角色（D-11）', built[0]?.meta?.agentPreset === 'qq-coding', `preset=${built[0]?.meta?.agentPreset}`)
  await send(server, { groupId: OTHER_GROUP })
  check('角色名写成 true → 按 guest（fail-closed）', built[1]?.meta?.agentPreset === 'qq-readonly', `preset=${built[1]?.meta?.agentPreset}`)
  await send(server, { groupId: 999999 })
  check('数字群号也能对上字符串键', built[2]?.meta?.agentPreset === 'qq-coding', `preset=${built[2]?.meta?.agentPreset}`)
  check('fail-closed 的那个群没有多给权限（只有 999999 / admin 两次授权调用）',
    permissionCalls.length === 2, JSON.stringify(permissionCalls))
  bridge.stop()
}

// ===== 4. 字符串群号也能对上 =====
{
  const server = new MockServer()
  const { ctx, built } = makeCtx()
  const bridge = new QQBridge(ctx, makeConfig({ [`${DEV_GROUP}`]: 'owner' }), server, { info() {}, warn() {}, error() {} })
  bridge.start()
  await send(server, { groupId: DEV_GROUP })
  check('字符串群号（配置里写成 "176628359"）命中 owner', built[0]?.meta?.agentPreset === 'qq-coding', `preset=${built[0]?.meta?.agentPreset}`)
  bridge.stop()
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
