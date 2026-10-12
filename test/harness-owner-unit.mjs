/**
 * [本地补丁] P1 托管权心跳与选主（SPEC-ownership-and-takeover §3 L1）验收测试。
 *
 * 覆盖：
 *   1. 心跳记录与名册读取：TTL 过期忽略、坏文件忽略、目录不存在返回空；
 *   2. 选主规则：kind 优先级 host > desktop > container → startedAt 早者 → instanceId；
 *   3. canTakeOver：空名册可接手；宿主活着时容器被挡；同级先到者胜；
 *   4. CLI（control/bin/qq-harness-owner.mjs）：--check 退出码、--claim 落盘、--release 删除；
 *   5. 插件接线：start() 写自己的心跳、/health 显示托管权、stop() 删掉自己的心跳。
 */
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_TTL_SECONDS, buildHeartbeat, canTakeOver, detectKind, electOwner,
  harnessStateDir, heartbeatFile, readHeartbeats, removeHeartbeat, summarizeOwner, writeHeartbeat,
} from '../lib/harness-heartbeat.js'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'control', 'bin', 'qq-harness-owner.mjs')
const root = mkdtempSync(join(tmpdir(), 'qq-harness-owner-'))
const dir = join(root, 'harness')
const now = Date.now()

// ---------------------------------------------------------------------------
// 1) 记录、读取、TTL
// ---------------------------------------------------------------------------
check('目录不存在时名册为空', readHeartbeats(join(root, 'nope')).fresh.length === 0)
const hostBeat = buildHeartbeat({ instanceId: 'host-a', kind: 'host', pid: 111, port: 3080, startedAt: now - 10_000, now, version: '0.7.3' })
writeHeartbeat(dir, hostBeat)
const read1 = readHeartbeats(dir, { now })
check('写进去的心跳能读出来', read1.fresh.length === 1 && read1.fresh[0].instanceId === 'host-a', JSON.stringify(read1.fresh.map((r) => r.instanceId)))
check('心跳带年龄（秒）', Number.isFinite(read1.fresh[0].ageSeconds), String(read1.fresh[0].ageSeconds))
const readStale = readHeartbeats(dir, { now: now + (DEFAULT_TTL_SECONDS + 5) * 1000 })
check('TTL 过期的心跳被忽略（stale 计数）', readStale.fresh.length === 0 && readStale.stale === 1, JSON.stringify({ fresh: readStale.fresh.length, stale: readStale.stale }))
writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8')
writeFileSync(join(dir, 'ignored.txt'), 'x', 'utf8')
check('坏文件与非 .json 文件被忽略', readHeartbeats(dir, { now }).fresh.length === 1)

// ---------------------------------------------------------------------------
// 2) 选主
// ---------------------------------------------------------------------------
const fresh = [
  buildHeartbeat({ instanceId: 'container-1', kind: 'container', pid: 1, startedAt: now - 100_000, now }),
  buildHeartbeat({ instanceId: 'host-1', kind: 'host', pid: 2, startedAt: now - 1_000, now }),
  buildHeartbeat({ instanceId: 'desktop-1', kind: 'desktop', pid: 3, startedAt: now - 50_000, now }),
]
check('选主：宿主优先于桌面端与容器', electOwner(fresh).instanceId === 'host-1', electOwner(fresh).instanceId)
const sameKind = [
  buildHeartbeat({ instanceId: 'host-late', kind: 'host', startedAt: now - 1_000, now }),
  buildHeartbeat({ instanceId: 'host-early', kind: 'host', startedAt: now - 9_000, now }),
]
check('选主：同级比 startedAt，早者胜', electOwner(sameKind).instanceId === 'host-early', electOwner(sameKind).instanceId)
const tie = [
  buildHeartbeat({ instanceId: 'host-b', kind: 'host', startedAt: now - 5_000, now }),
  buildHeartbeat({ instanceId: 'host-a', kind: 'host', startedAt: now - 5_000, now }),
]
check('选主：完全平票时按 instanceId（结果确定）', electOwner(tie).instanceId === 'host-a', electOwner(tie).instanceId)
check('选主：空名册返回 null', electOwner([]) === null)
check('摘要说清楚是谁在托管', summarizeOwner(electOwner(fresh), { selfId: 'x' }).includes('host 实例'), summarizeOwner(electOwner(fresh), { selfId: 'x' }))

// ---------------------------------------------------------------------------
// 3) canTakeOver
// ---------------------------------------------------------------------------
const dir2 = join(root, 'harness2')
check('空名册：容器可以接手', canTakeOver(dir2, { kind: 'container' }).ok === true)
writeHeartbeat(dir2, buildHeartbeat({ instanceId: 'host-live', kind: 'host', pid: 9, port: 3080, startedAt: now, now }))
const blocked = canTakeOver(dir2, { kind: 'container' })
check('宿主活着：容器被挡下，并说明原因', blocked.ok === false && blocked.reason.includes('host'), blocked.reason)
check('宿主活着：宿主自己不受挡（同级先到者胜会挡后来者）', canTakeOver(dir2, { kind: 'host' }).ok === false)
const dir3 = join(root, 'harness3')
writeHeartbeat(dir3, buildHeartbeat({ instanceId: 'container-live', kind: 'container', startedAt: now, now }))
check('只有容器活着：宿主可以接手', canTakeOver(dir3, { kind: 'host' }).ok === true)

// ---------------------------------------------------------------------------
// 4) CLI
// ---------------------------------------------------------------------------
const cliDir = join(root, 'harness-cli')
const run = (args, env = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      env: { ...process.env, QQ_HARNESS_STATE_DIR: cliDir, ...env }, encoding: 'utf8',
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') }
  }
}
check('CLI：空名册 --check 退出码 0', run(['--kind', 'container', '--check']).code === 0)
const claim = run(['--kind', 'host', '--claim', '--instance', 'host-cli'])
check('CLI：--claim 落盘并可被名册读到', claim.code === 0 && readHeartbeats(cliDir, { now: Date.now() }).fresh.some((r) => r.instanceId === 'host-cli'), claim.stdout.trim())
const blockedCli = run(['--kind', 'container', '--check'])
check('CLI：宿主心跳在时容器 --check 退出码 2', blockedCli.code === 2, blockedCli.stdout.trim())
const release = run(['--kind', 'host', '--release', '--instance', 'host-cli'])
check('CLI：--release 删掉自己的心跳', release.code === 0 && !existsSync(heartbeatFile(cliDir, 'host-cli')), release.stdout.trim())
check('CLI：--release 对不存在的心跳如实说"本来就不在"', run(['--kind', 'host', '--release', '--instance', 'nope']).stdout.includes('本来就不在'))
const roster = run([])
check('CLI：默认输出列出 owner 与名册', roster.stdout.includes('当前 owner'), roster.stdout.split('\n')[0])

// ---------------------------------------------------------------------------
// 5) 插件接线：start 写心跳、/health 显示、stop 删除
// ---------------------------------------------------------------------------
const stateDir = join(root, 'state')
process.env.QQ_HARNESS_STATE_DIR = join(root, 'harness-bridge')
mkdirSync(stateDir, { recursive: true })

class MockServer extends EventEmitter {
  constructor() { super(); this.sent = []; this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} } }
  sendSegments(_bot, messageType, targetId, segments) { this.sent.push({ messageType, targetId, segments }); return Promise.resolve({ message_id: 'm1' }) }
  sendText(bot, messageType, targetId, text) { return this.sendSegments(bot, messageType, targetId, [{ type: 'text', data: { text } }]) }
  currentSocket() { return this.socket }
}
const handlers = new Map()
const ctx = {
  on: (event, handler) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); return () => {} },
  get: () => undefined,
  reflect: { get: () => undefined },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  agents: { create: async () => ({ agent: { status: 'idle', followup: () => {}, cancel: () => {} }, dispose: async () => {} }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}
const bridgeServer = new MockServer()
const bridge = new QQBridge(ctx, Config({
  cwd: stateDir, allowUsers: [1001], acceptPrivate: true, botQq: 999,
  harnessHeartbeatSeconds: 2, historyArchiveEnabled: false, memoryEnabled: false, preclaimSessions: false,
  identity: { enabled: true, map: { 1001: 'owner' }, defaultRole: 'guest', groupRole: 'guest',
    roles: { owner: { preset: 'qq-coding', cwd: stateDir }, guest: { preset: 'qq-readonly', cwd: join(root, 'guest') } } },
}), bridgeServer, { info() {}, warn() {}, error() {} })
bridge.start({ serving: true })
const ownFiles = readdirSync(process.env.QQ_HARNESS_STATE_DIR).filter((name) => name.endsWith('.json'))
check('插件：start() 写下自己的心跳', ownFiles.length === 1, ownFiles.join(','))
const own = JSON.parse(readFileSync(join(process.env.QQ_HARNESS_STATE_DIR, ownFiles[0]), 'utf8'))
check('插件：心跳字段齐全（kind/pid/port/version）',
  ['container', 'host', 'desktop'].includes(own.kind) && own.pid === process.pid && own.port === 6700 && own.version !== '',
  JSON.stringify({ kind: own.kind, pid: own.pid, port: own.port, version: own.version }))
check('插件：选主结果是自己', bridge.harnessHb?.owner?.instanceId === bridge.harnessHb?.instanceId, String(bridge.harnessHb?.owner?.instanceId))

let healthReply = ''
// /health 由桥自己监听的 server 触发（同一个实例，否则桥收不到）
bridgeServer.emit('message', {
  bot: bridgeServer.socket, userId: 1001, messageType: 'private', groupId: 0, text: '/health', atMe: false,
  ats: [], reply: null, records: [], images: [], files: [], messageId: 'h1', senderName: 't', raw: { message: [] },
})
await new Promise((r) => setTimeout(r, 300))
healthReply = bridgeServer.sent.map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
check('插件：/health 显示托管权一行', healthReply.includes('托管权：'), healthReply.split('\n').find((l) => l.includes('托管权')) ?? '(none)')
const snapshotFile = join(stateDir, 'qq-runtime.json')
check('插件：运行快照带 ownership（控制台可直接读）',
  existsSync(snapshotFile) && JSON.parse(readFileSync(snapshotFile, 'utf8')).ownership?.running === true,
  existsSync(snapshotFile) ? JSON.stringify(JSON.parse(readFileSync(snapshotFile, 'utf8')).ownership?.owner ?? null) : 'no snapshot')
bridge.stop()
await new Promise((r) => setTimeout(r, 100))
const afterStop = readdirSync(process.env.QQ_HARNESS_STATE_DIR).filter((name) => name.endsWith('.json'))
check('插件：stop() 删掉自己的心跳', afterStop.length === 0, afterStop.join(','))

check('detectKind：env 显式指定优先', detectKind({ env: { QQ_HARNESS_KIND: 'desktop' }, exists: () => false }) === 'desktop')
check('detectKind：容器标记可识别', detectKind({ env: {}, exists: (p) => p === '/.dockerenv', platform: 'linux' }) === 'container')
check('harnessStateDir：env 覆盖优先', harnessStateDir({ env: { QQ_HARNESS_STATE_DIR: '/tmp/x' } }) === '/tmp/x')
check('harnessStateDir：默认落 DSH_HOME/state/harness', harnessStateDir({ env: { DSH_HOME: '/data/dsh' } }) === join('/data/dsh', 'state', 'harness'))

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
