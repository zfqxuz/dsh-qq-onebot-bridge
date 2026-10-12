#!/usr/bin/env node
/**
 * [本地补丁] 接管状态机（SPEC-ownership-and-takeover §3 L3）——容器/harness 的启动外壳。
 *
 *   node control/bin/qq-harness-supervisor.mjs [--kind container] [--state-file <路径>] [--no-probe] \
 *     -- node /app/dsh-web-run.mjs --port 3081 --data-root /data/qqbot -- dsh web --no-open --port 3081
 *
 * 行为：每 poll 秒看一次名册（插件与宿主启动器写的心跳）+ 外部探测（P3，可选），
 *   · 名册连续为空满 T1 → 启动子进程（成为 owner）；
 *   · 宿主心跳回来满 T2 → 给子进程 SIGTERM（drain：停收新消息、等在飞回合），到 drain 上限再 SIGKILL，
 *     然后回到待机（宿主优先）；
 *   · 交回后 minHold 秒内不再抢；一小时最多切换 N 次，超了停在待机并告警。
 * 状态写两份：state/harness-supervisor.json（总状态，控制台读）与 state/harness-standby.json
 * （只在待机/候选时存在，向后兼容 P1 的控制台卡片）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { harnessStateDir, readHeartbeats } from '../../lib/harness-heartbeat.js'
import { DEFAULT_PARAMS, createSupervisorState, paramsFromEnv, stepSupervisor } from '../lib/harness-supervisor.mjs'

const argv = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)
const dashDash = argv.indexOf('--')
const command = dashDash >= 0 ? argv.slice(dashDash + 1) : []

const env = process.env
const params = { ...DEFAULT_PARAMS, ...paramsFromEnv(env) }
params.kind = argOf('kind', params.kind)
const dataRoot = argOf('data-root', env.QQ_DATA_ROOT || process.cwd())
const stateDir = join(dataRoot, 'state')
const supervisorFile = argOf('state-file', join(stateDir, 'harness-supervisor.json'))
const standbyFile = join(stateDir, 'harness-standby.json')
const registryDir = argOf('registry-dir', harnessStateDir())
const noProbe = has('no-probe')

// 本 supervisor 的身份：起 harness 时通过 QQ_HARNESS_OWNED_BY 传给子进程，
// 子进程里的插件把它写进心跳 —— tick 时据此把"我起的 harness"从竞争者里摘掉。
// （2026-10-12 实跑复现：不带这个字段时，自己的 harness 写心跳满 T2 后会被自己 drain，30 秒一轮自杀循环。）
const supervisorId = argOf('instance', String(process.env.QQ_HARNESS_SUPERVISOR_ID ?? '').trim())
  || `supervisor-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const supervisorStartedAt = Date.now()

const log = (line) => console.log(`[supervisor] ${line}`)

/** 外部探测（P3 落地后自动启用；没有该模块就当"探测不可用"）。 */
let probeFn = null
if (noProbe !== true) {
  try {
    const mod = await import('../lib/probe.mjs')
    probeFn = mod.probeForeignHarnesses
  } catch { probeFn = null }
}

let child = null
let stopping = false
let lastSpawnAt = 0
let rapidRestarts = 0
const state = createSupervisorState({ params, kind: params.kind, mode: params.mode })
let lastLine = ''

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (error) {
    log(`写 ${file} 失败：${error.message}`)
    return false
  }
}

function spawnChild() {
  if (child !== null) return
  const now = Date.now()
  // 崩得太快：先退避，避免"起了就崩"把日志刷爆
  if (lastSpawnAt !== 0 && now - lastSpawnAt < 5_000) {
    rapidRestarts += 1
    if (rapidRestarts <= 5 || rapidRestarts % 20 === 0) log(`harness 5 秒内又退出了（第 ${rapidRestarts} 次）→ 稍后再拉起`)
    if (rapidRestarts >= 5) {
      state.alerts.push('rapid-restart')
      setTimeout(() => { rapidRestarts = 0; spawnChild() }, 60_000).unref()
      return
    }
    setTimeout(() => spawnChild(), 5_000).unref()
    return
  }
  rapidRestarts = 0
  lastSpawnAt = now
  const cmd = command.length > 0 ? command : ['dsh', 'web', '--no-open', '--port', String(env.DSH_PORT || 3081)]
  log(`启动 harness：${cmd.map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ') }`)
  child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...env, QQ_HARNESS_OWNED_BY: supervisorId } })
  child.on('exit', (code, signal) => {
    log(`harness 退出（code=${code ?? '-'} signal=${signal ?? '-'}）`)
    child = null
  })
}

async function drainChild(force = false) {
  if (child === null) return
  const target = child
  log(force ? 'harness 仍在跑：SIGKILL' : '交回宿主：给 harness 发 SIGTERM（drain）')
  try {
    target.kill(force ? 'SIGKILL' : 'SIGTERM')
  } catch { /* 已经退了 */ }
}

async function tick() {
  const now = Date.now()
  const { fresh: freshAll } = readHeartbeats(registryDir, { ttlSeconds: Math.max(15, params.pollSeconds * 3) })
  // 自己起的 harness 不算竞争者（它和自己同级；少了这一条会自杀，见 supervisorId）
  const fresh = freshAll.filter((item) => String(item.ownedBy ?? '') !== supervisorId)
  let probe = { available: false, foreign: [], reason: '探测未启用' }
  if (probeFn !== null) {
    try {
      probe = await probeFn({
        env, dataRoot,
        ownPids: child === null ? [] : [child.pid],
        ownPort: Number(env.DSH_PORT || env.QQ_DSH_PORT) || 0,
        sessionsDir: join(String(env.DSH_HOME ?? '').trim() || join(dataRoot, '..'), 'sessions'),
      })
    } catch (error) {
      probe = { available: false, foreign: [], reason: `探测失败：${error.message}` }
    }
  }
  const roster = [
    ...fresh,
    ...(probe.foreign ?? []).map((item) => ({ instanceId: item.id ?? item.pid ?? 'foreign', kind: item.kind ?? 'host', pid: item.pid ?? 0, ...item })),
  ]
  const result = stepSupervisor(
    state,
    { roster, probe, childRunning: child !== null, self: { instanceId: supervisorId, kind: params.kind, startedAt: supervisorStartedAt } },
    { now, params },
  )

  for (const action of result.actions) {
    if (action === 'spawn') spawnChild()
    if (action === 'drain') void drainChild(false)
    if (action === 'kill') void drainChild(true)
  }

  writeJson(supervisorFile, {
    at: now, state: result.state, reason: result.reason, since: state.since, kind: state.kind, mode: state.mode,
    instanceId: supervisorId,
    startedAt: supervisorStartedAt,
    childPid: child === null ? 0 : child.pid ?? 0,
    switches: state.switches.length, alerts: state.alerts,
    params: { t1Seconds: params.t1Seconds, t2Seconds: params.t2Seconds, minHoldSeconds: params.minHoldSeconds, drainSeconds: params.drainSeconds },
    registryDir,
    roster: roster.map((item) => ({ kind: item.kind, pid: item.pid, instanceId: item.instanceId, ageSeconds: item.ageSeconds })),
    probe: { available: probe.available === true, count: (probe.foreign ?? []).length, reason: probe.reason ?? '' },
  })
  if (result.state === 'standby' || result.state === 'candidate' || result.state === 'probe') {
    writeJson(standbyFile, {
      at: now, mode: 'standby', kind: state.kind, modeEnv: state.mode,
      reason: result.reason, supervisorState: result.state,
    })
  } else {
    try { rmSync(standbyFile, { force: true }) } catch { /* 无所谓 */ }
  }

  if (result.reason !== lastLine) {
    lastLine = result.reason
    log(`[${result.state}] ${result.reason}`)
  }
}

async function main() {
  log(`启动：身份=${supervisorId} kind=${params.kind} mode=${params.mode} T1=${params.t1Seconds}s T2=${params.t2Seconds}s minHold=${params.minHoldSeconds}s 探测=${probeFn === null ? '关' : '开'}`)
  await tick()
  const timer = setInterval(() => { void tick().catch((error) => log(`tick 异常：${error.message}`)) }, Math.max(1, params.pollSeconds) * 1000)
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (stopping) return
      stopping = true
      clearInterval(timer)
      log(`收到 ${sig}：drain 后退出`)
      const deadline = Date.now() + params.drainSeconds * 1000
      const wait = setInterval(() => {
        if (child === null || Date.now() >= deadline) {
          clearInterval(wait)
          if (child !== null) void drainChild(true)
          writeJson(supervisorFile, { at: Date.now(), state: 'stopped', reason: `收到 ${sig}`, since: Date.now(), kind: state.kind, mode: state.mode })
          setTimeout(() => process.exit(0), 200).unref()
        }
      }, 500)
      void drainChild(false)
    })
  }
}

void main()
