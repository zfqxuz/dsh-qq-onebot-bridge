/**
 * 保留期清理验收测试（2026-10-09 用户要求）。
 *
 * 覆盖三件事：
 *  (a) **定时**清理：以前只有"宿主启动那一次"，长期不重启就等于不清理；
 *  (b) **回收站二次清理**：第一道保留期把文件"移入" qq-trash/（绝不真删），
 *      但回收站原来只进不出 → 现在按 保留天数 + 总大小上限 从最老日期桶开始真删；
 *  (c) **qq-tts 纳入保留期**：原来只遍历 image/quote/files，tts 是漏网的。
 *
 * 用环境变量把 cwd 指到临时目录，不碰真实运行态。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
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

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  sendSegments(_bot, messageType, targetId, segments) { this.sent.push({ messageType, targetId, segments }); return Promise.resolve({ message_id: `m${this.sent.length}` }) }
  sendText(_bot, messageType, targetId, text) { return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }]) }
  currentSocket() { return this.socket }
}

function makeCtx() {
  const ctx = {
    on: () => () => {},
    get: () => undefined,
    reflect: { get: () => undefined },
    agents: {
      create: async (options) => ({ agent: { id: String(options.sessionId), status: 'idle', followup: async () => {}, cancel() {} }, dispose: async () => {} }),
      resume: async (options) => ({ agent: { id: String(options.resumeSessionId), status: 'idle', followup: async () => {}, cancel() {} }, dispose: async () => {} }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return ctx
}

const DAY = 86_400_000
function makeBaseConfig(cwd, overrides = {}) {
  return Config({
    cwd,
    allowUsers: [1001],
    acceptPrivate: true,
    botQq: 999,
    adminEnabled: false,
    sessionResumeEnabled: false,
    historyArchiveEnabled: false,
    memoryEnabled: false,
    preclaimSessions: false,
    reconcileSessions: false,
    notifyEnabled: false,
    watchdogAlertEnabled: false,
    traceEnabled: false,
    ...overrides,
  })
}

/** 写一个文件并把 mtime 调到 N 天前。 */
function writeAged(file, ageDays, content = 'x') {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
  const t = (Date.now() - ageDays * DAY) / 1000
  utimesSync(file, t, t)
}

function startBridge(cwd, overrides = {}) {
  const bridge = new QQBridge(makeCtx(), makeBaseConfig(cwd, overrides), new MockServer(), { info() {}, warn() {}, error() {} })
  bridge.start()
  return bridge
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ===========================================================================
// A + C：启动清理把图片/引用/tts 的过期文件移入回收站；并在同一轮做回收站二次清理
// ===========================================================================
{
  const cwd = mkdtempSync(join(tmpdir(), 'qq-retention-'))
  writeAged(join(cwd, 'qq-images', 'old.png'), 20)
  writeAged(join(cwd, 'qq-replies', 'old.png'), 20)
  writeAged(join(cwd, 'qq-tts', 'old.mp3'), 20)        // (c) 以前漏掉的就是它
  writeAged(join(cwd, 'qq-images', 'fresh.png'), 1)     // 不该被动

  // 回收站：一个远超保留期的老桶 + 今天的桶
  writeAged(join(cwd, 'qq-trash', '2020-01-01', 'ancient.bin'), 1)
  writeAged(join(cwd, 'qq-trash', 'today-bucket-name-not-a-date', 'keepme.bin'), 1)
  const today = new Date().toISOString().slice(0, 10)
  writeAged(join(cwd, 'qq-trash', today, 'recent.bin'), 1)

  const bridge = startBridge(cwd, { imageRetentionDays: 14, trashRetentionDays: 30, trashMaxBytes: 0 })
  await sleep(400)

  const left = (dir) => { try { return readdirSync(join(cwd, dir)) } catch { return [] } }
  check('过期图片已移出 qq-images', !left('qq-images').includes('old.png'), JSON.stringify(left('qq-images')))
  check('新鲜图片保留（没被误清）', left('qq-images').includes('fresh.png'), JSON.stringify(left('qq-images')))
  check('过期引用图片已移出 qq-replies', !left('qq-replies').includes('old.png'), JSON.stringify(left('qq-replies')))
  check('(c) 过期 tts 已移出 qq-tts（原来漏掉的目录）', !left('qq-tts').includes('old.mp3'), JSON.stringify(left('qq-tts')))
  check('移入回收站的是今天的日期桶', left(join('qq-trash', today)).includes('old.mp3'),
    JSON.stringify(left(join('qq-trash', today))))
  check('(b) 超过 30 天的回收站日期桶被真删', !existsSync(join(cwd, 'qq-trash', '2020-01-01')))
  check('(b) 今天的回收站桶保留', existsSync(join(cwd, 'qq-trash', today)))
  check('(b) 非日期桶名一律不碰', existsSync(join(cwd, 'qq-trash', 'today-bucket-name-not-a-date', 'keepme.bin')))
  bridge.stop()
}

// ===========================================================================
// B：回收站总大小上限 —— 超限时从最老的日期桶开始真删
// ===========================================================================
{
  const cwd = mkdtempSync(join(tmpdir(), 'qq-retention-cap-'))
  const d1 = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10)   // 较老
  const d2 = new Date(Date.now() - 1 * DAY).toISOString().slice(0, 10)   // 较新
  writeAged(join(cwd, 'qq-trash', d1, 'a.bin'), 1, 'A'.repeat(2000))
  writeAged(join(cwd, 'qq-trash', d2, 'b.bin'), 1, 'B'.repeat(2000))

  // 上限 2500 字节：两个桶共 4000 → 必须删掉最老的那个
  const bridge = startBridge(cwd, { trashRetentionDays: 3650, trashMaxBytes: 2500 })
  await sleep(400)
  check('(b) 超上限时先删最老的日期桶', !existsSync(join(cwd, 'qq-trash', d1)))
  check('(b) 上限之内后保留较新的桶', existsSync(join(cwd, 'qq-trash', d2)))
  bridge.stop()
}

// ===========================================================================
// A：定时清理 —— 启动后按周期再跑（用 QQ_RETENTION_SWEEP_MS 把间隔压到毫秒级）
// ===========================================================================
{
  const cwd = mkdtempSync(join(tmpdir(), 'qq-retention-timer-'))
  writeAged(join(cwd, 'qq-trash', '2020-01-01', 'x.bin'), 1)
  process.env.QQ_RETENTION_SWEEP_MS = '150'
  const bridge = startBridge(cwd, { trashRetentionDays: 30, trashMaxBytes: 0 })
  // 启动清理已经把 2020 桶删了 —— 再造一个，验证"定时"那一轮会把它清掉
  writeAged(join(cwd, 'qq-trash', '2019-01-01', 'y.bin'), 1)
  check('(a) 前置：新造的过期桶还在', existsSync(join(cwd, 'qq-trash', '2019-01-01')))
  await sleep(500)
  check('(a) 定时那一轮把过期桶清掉（不靠重启）', !existsSync(join(cwd, 'qq-trash', '2019-01-01')))
  bridge.stop()
  delete process.env.QQ_RETENTION_SWEEP_MS
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
