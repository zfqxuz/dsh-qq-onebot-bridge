/**
 * [本地补丁] supervisor 外壳的"自己人"回归（SPEC-ownership-and-takeover §3 L3）。
 *
 * 这条测的是**真实子进程**：supervisor 起一个假 harness，假 harness 模仿插件按
 * QQ_HARNESS_OWNED_BY 往名册里写自己的心跳。旧实现里 supervisor 认不出这是自己起的实例，
 * 会当成"竞争者回来了"，满 T2 后 drain 掉自己的 harness —— 30 秒一轮自杀循环
 * （2026-10-12 在真机上复现过，容器起来就来回断）。这里锁住：
 *   1. 子进程心跳里的 ownedBy 就是 supervisor 的 instanceId（env 传得下去）；
 *   2. 子进程一直写心跳，超过 T2 也保持 owner、不 drain；
 *   3. 对照：出现一个"更早的同类实例"仍然会让位（drain）——修的是自己人，不是把让位逻辑删了。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'sup-child-'))
const registry = join(dir, 'registry')
mkdirSync(registry, { recursive: true })
const stateFile = join(dir, 'state', 'harness-supervisor.json')

// 假 harness：像插件那样每 400ms 写一条 kind=container 的心跳，ownedBy 从环境变量拿
const childScript = join(dir, 'fake-harness.mjs')
writeFileSync(childScript, `
import { buildHeartbeat, writeHeartbeat } from ${JSON.stringify(join(root, 'lib/harness-heartbeat.js'))}
const dir = process.env.QQ_HARNESS_STATE_DIR
const ownedBy = String(process.env.QQ_HARNESS_OWNED_BY ?? '')
const instanceId = 'bridge-container-fake-' + process.pid
const beat = () => {
  try {
    writeHeartbeat(dir, buildHeartbeat({
      instanceId, kind: 'container', pid: process.pid, port: 6700,
      startedAt: Number(process.env.FAKE_STARTED_AT) || Date.now(), now: Date.now(), ownedBy,
    }))
  } catch (error) { console.error('fake-harness beat failed: ' + error.message) }
}
beat()
const timer = setInterval(beat, 400)
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })
`)

const sup = spawn(process.execPath, [
  join(root, 'control/bin/qq-harness-supervisor.mjs'), '--kind', 'container',
  '--data-root', dir, '--registry-dir', registry, '--no-probe',
  '--', process.execPath, childScript,
], {
  env: {
    ...process.env,
    QQ_HARNESS_STATE_DIR: registry,
    // 显式定死模式/身份：这类端到端测试不能再继承运行环境的 QQ_HARNESS_*（
    // 本机容器里就带着 QQ_HARNESS_MODE=container-only，会让"让位"对照项永远不触发）。
    QQ_HARNESS_MODE: 'auto', QQ_HARNESS_KIND: 'container',
    QQ_TAKEOVER_T1_SECONDS: '1', QQ_TAKEOVER_T2_SECONDS: '2',
    QQ_MIN_HOLD_SECONDS: '1', QQ_HARNESS_POLL_SECONDS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
sup.stdout.on('data', (d) => { out += d })
sup.stderr.on('data', (d) => { out += d })

const readState = () => {
  try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null }
}
const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = readState()
    if (value !== null && predicate(value)) return value
    await sleep(200)
  }
  return null
}

// 1) 等到接管
const owner = await waitFor((s) => s.state === 'owner' && Number(s.childPid) > 0, 15_000)
check('名册空满 T1 → 接管并起了子进程', owner !== null, owner === null ? `state=${JSON.stringify(readState())}` : `childPid=${owner.childPid} owner=${owner.instanceId}`)

// 2) 子进程的心跳里带着 supervisor 的身份
await sleep(1_500)
const beats = (() => {
  try {
    return readdirSync(registry)
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(registry, n), 'utf8')))
  } catch { return [] }
})()
check('子进程的心跳写进来了', beats.length === 1 && beats[0].kind === 'container', JSON.stringify(beats.map((b) => [b.instanceId, b.kind])))
check('心跳的 ownedBy == supervisor 的 instanceId（env 传得下去）',
  beats.length === 1 && beats[0].ownedBy === owner?.instanceId,
  `ownedBy=${beats[0]?.ownedBy} supervisor=${owner?.instanceId}`)

// 3) 超过 T2 仍然托管（旧实现会在这里 drain 掉自己）
await sleep(4_500)
const afterT2 = readState()
check('子进程持续写心跳、超过 T2 也不 drain（不再自杀）',
  afterT2?.state === 'owner' && !out.includes('drain'),
  `state=${afterT2?.state} ${afterT2?.reason}`)

// 4) 对照：出现"更早的同类实例" → 仍然让位
const now = Date.now()
writeFileSync(join(registry, 'bridge-container-foreign.json'), `${JSON.stringify({
  instanceId: 'bridge-container-foreign', kind: 'container', pid: 4321, port: 6700,
  home: registry, workspace: '', host: 'test', platform: 'linux',
  startedAt: now - 600_000, heartbeatAt: now, version: 'test', ownedBy: '',
}, null, 2)}\n`)
const yielded = await waitFor((s) => s.state === 'draining' || s.state === 'standby' || s.state === 'candidate', 12_000)
check('更早的同类实例出现 → 让位（drain/待机），对照项没被一起删掉',
  yielded !== null && /drain/.test(out),
  `state=${yielded?.state} 日志含 drain=${/drain/.test(out)}`)

sup.kill('SIGTERM')
await sleep(500)
try { sup.kill('SIGKILL') } catch { /* 已经退了 */ }
rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
