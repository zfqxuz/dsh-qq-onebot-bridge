/**
 * [本地补丁] P2 接管状态机（SPEC-ownership-and-takeover §3 L3）验收测试。
 *
 * 全是纯逻辑：给 createSupervisorState/stepSupervisor 喂"名册 + 探测 + 子进程是否活着"，
 * 断言状态迁移与发出的动作（spawn / drain / kill / wait），不碰真实进程与时钟。
 *
 * 覆盖：T1 才接管；T2 才交回；交回后 minHold 内不抢；一小时切换上限；container-only 忽略宿主；
 * strict 下探测不可用就不接管；drain 超时强杀；子进程崩了会重新拉起。
 */
import { DEFAULT_PARAMS, createSupervisorState, paramsFromEnv, stepSupervisor } from '../control/lib/harness-supervisor.mjs'
import { buildHeartbeat } from '../lib/harness-heartbeat.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const P = { ...DEFAULT_PARAMS, t1Seconds: 10, t2Seconds: 5, minHoldSeconds: 20, switchesPerHour: 3, pollSeconds: 1, drainSeconds: 30 }
const T0 = 1_700_000_000_000
const host = () => buildHeartbeat({ instanceId: 'host-1', kind: 'host', pid: 11, port: 3080, startedAt: T0 - 5_000, now: T0 })
const drive = (state, seconds, input = {}, params = P) => stepSupervisor(state, input, { now: T0 + seconds * 1000, params })

// 1) probe → candidate → （T1 未到不接管）→ owner
{
  const st = createSupervisorState({ params: P, now: T0, kind: 'container' })
  let r = drive(st, 0, { roster: [] })
  check('首拍进入候选而不是立刻接管', r.state === 'candidate' && r.actions.length === 0, `${r.state} ${r.reason}`)
  r = drive(st, 5, { roster: [] })
  check('T1 未到不接管（只等）', r.state === 'candidate' && r.actions.length === 0, `${r.state} ${r.reason}`)
  r = drive(st, 10, { roster: [] })
  check('名册空满 T1 → 接管并 spawn', r.state === 'owner' && r.actions.includes('spawn'), `${r.state} ${JSON.stringify(r.actions)}`)
}

// 2) owner 时宿主回来：T2 之前不动，T2 之后 drain
{
  const st = createSupervisorState({ params: P, now: T0, kind: 'container' })
  drive(st, 0, { roster: [] }); drive(st, 10, { roster: [] })
  const roster = [host()]
  let r = drive(st, 12, { roster }, P)
  check('宿主刚回来：仍在托管（等 T2）', r.state === 'owner' && !r.actions.includes('drain'), `${r.state} ${r.reason}`)
  r = drive(st, 18, { roster }, P)
  check('宿主回来满 T2 → 开始 drain', r.state === 'draining' && r.actions.includes('drain'), `${r.state} ${JSON.stringify(r.actions)}`)
  r = drive(st, 20, { roster, childRunning: false }, P)
  check('子进程退出 → 交回完成、回到待机', r.state === 'standby' && r.reason.includes('交回'), `${r.state} ${r.reason}`)
}

// 3) drain 到上限：强杀
{
  const st = createSupervisorState({ params: P, now: T0, kind: 'container' })
  drive(st, 0, { roster: [] }); drive(st, 10, { roster: [] })
  const roster = [host()]
  drive(st, 18, { roster, childRunning: true }, P)              // 宿主出现（开始 T2 计时）
  drive(st, 18 + P.t2Seconds + 1, { roster, childRunning: true }, P)  // 满 T2 → draining
  const r = drive(st, 18 + P.t2Seconds + 1 + P.drainSeconds + 1, { roster, childRunning: true }, P)
  check('drain 超上限 → kill 并回待机', r.state === 'standby' && r.actions.includes('kill'), `${r.state} ${JSON.stringify(r.actions)}`)
}

// 4) minHold：交回后宿主又没了，也要等冷却结束才抢
{
  const st = createSupervisorState({ params: P, now: T0, kind: 'container' })
  drive(st, 0, { roster: [] }); drive(st, 10, { roster: [] })
  const roster = [host()]
  drive(st, 18, { roster, childRunning: true }, P)                       // 宿主出现
  const hand = drive(st, 18 + P.t2Seconds + 1, { roster, childRunning: true }, P)  // 满 T2 → drain
  const back = drive(st, 18 + P.t2Seconds + 2, { roster, childRunning: false }, P) // 子进程退出 → 交回
  check('交回发生（drain → standby）', hand.state === 'draining' && back.state === 'standby', `${hand.state}→${back.state}`)
  let r = drive(st, 18 + P.t2Seconds + 10, { roster: [] }, P)            // 名册空但 minHold 未到
  check('minHold 内不抢（名册空也继续等）', r.state === 'candidate' && !r.actions.includes('spawn'), `${r.state} ${r.reason}`)
  r = drive(st, 18 + P.t2Seconds + P.minHoldSeconds + P.t1Seconds + 5, { roster: [] }, P)
  check('minHold + T1 之后才重新接管', r.state === 'owner' && r.actions.includes('spawn'), `${r.state} ${r.reason}`)
}

// 5) 一小时切换上限
{
  const st = createSupervisorState({ params: P, now: T0, kind: 'container' })
  st.switches = [T0 - 3_000_000, T0 - 2_000_000, T0 - 1_000_000]   // 一小时内已有 3 次
  drive(st, 0, { roster: [] })
  const r = drive(st, 30, { roster: [] }, P)
  check('切换达上限 → 停在候选并告警', r.state === 'candidate' && st.alerts.includes('switches'), `${r.state} ${r.reason}`)
}

// 6) container-only：忽略宿主心跳
{
  const st = createSupervisorState({ params: P, now: T0, kind: 'container', mode: 'container-only' })
  drive(st, 0, { roster: [host()] })
  const r = drive(st, 15, { roster: [host()] }, P)
  check('container-only：宿主心跳不挡路', r.state === 'owner' && r.actions.includes('spawn'), `${r.state} ${r.reason}`)
}

// 7) strict + 探测不可用：不接管
{
  const st = createSupervisorState({ params: P, now: T0, kind: 'container', mode: 'strict' })
  drive(st, 0, { roster: [], probe: { available: false } })
  const r = drive(st, 30, { roster: [], probe: { available: false } }, P)
  check('strict 且探测不可用 → 不接管', r.state === 'candidate' && !r.actions.includes('spawn'), `${r.state} ${r.reason}`)
}

// 8) 子进程崩了：owner 状态下重新拉起
{
  const st = createSupervisorState({ params: P, now: T0, kind: 'container' })
  drive(st, 0, { roster: [] }); drive(st, 10, { roster: [] })
  const r = drive(st, 12, { roster: [], childRunning: false }, P)
  check('子进程不在 → 重新 spawn', r.actions.includes('spawn'), JSON.stringify(r.actions))
}

// 10) 同级实例的决胜（self）：自己起的 harness 不算竞争者，别人先到才让位
//     —— 旧口径"kind 优先级 >= 自己都算"会把 supervisor 自己起的 harness 当成宿主回来，
//        T2 之后自杀（2026-10-12 实跑复现：30 秒一轮），这里锁住修复。
{
  const self = { instanceId: 'supervisor-mine', kind: 'container', startedAt: T0 }
  const mine = { ...buildHeartbeat({ instanceId: 'bridge-container-mine', kind: 'container', pid: 99, port: 6700, startedAt: T0 + 1_000, now: T0 }), ownedBy: 'supervisor-mine' }
  const older = buildHeartbeat({ instanceId: 'bridge-container-older', kind: 'container', pid: 98, port: 6700, startedAt: T0 - 60_000, now: T0 })
  const st = createSupervisorState({ params: P, now: T0, kind: 'container' })
  drive(st, 0, { roster: [], self }); drive(st, 10, { roster: [], self })
  let r = drive(st, 12, { roster: [mine], self, childRunning: true }, P)
  check('自己起的 harness（startedAt 更晚）不算竞争者', r.state === 'owner' && !r.actions.includes('drain'), `${r.state} ${r.reason}`)
  r = drive(st, 12 + P.t2Seconds + 10, { roster: [mine], self, childRunning: true }, P)
  check('自己的 harness 写心跳再久也不会被 drain（不再自杀）', r.state === 'owner' && !r.actions.includes('drain'), `${r.state} ${r.reason}`)

  const st2 = createSupervisorState({ params: P, now: T0, kind: 'container' })
  drive(st2, 0, { roster: [], self }); drive(st2, 10, { roster: [], self })
  r = drive(st2, 12, { roster: [older], self, childRunning: true }, P)
  check('更早的同级实例出现：先让位（等 T2）', r.state === 'owner' && !r.actions.includes('drain'), `${r.state} ${r.reason}`)
  r = drive(st2, 12 + P.t2Seconds + 1, { roster: [older], self, childRunning: true }, P)
  check('更早的同级实例满 T2 → drain（两个容器不会双双待机）', r.state === 'draining' && r.actions.includes('drain'), `${r.state} ${JSON.stringify(r.actions)}`)

  r = drive(st2, 12 + P.t2Seconds + 2, { roster: [host()], self, childRunning: true }, P)
  check('宿主（kind 更高）仍然压过容器', r.state === 'draining', `${r.state} ${r.reason}`)
}

// 9) 参数从 env 读，非法值回落默认
{
  const p = paramsFromEnv({ QQ_TAKEOVER_T1_SECONDS: '3', QQ_TAKEOVER_T2_SECONDS: 'x', QQ_HARNESS_MODE: 'strict', QQ_HARNESS_KIND: 'container' })
  check('参数：合法值生效、非法值回落默认', p.t1Seconds === 3 && p.t2Seconds === DEFAULT_PARAMS.t2Seconds && p.mode === 'strict' && p.kind === 'container',
    JSON.stringify({ t1: p.t1Seconds, t2: p.t2Seconds, mode: p.mode }))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
