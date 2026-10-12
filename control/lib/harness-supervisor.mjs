/**
 * [本地补丁] 接管状态机（SPEC-ownership-and-takeover §3 L3）——纯逻辑，便于单测。
 *
 * 谁在跑：
 *   PROBE ──名册空──▶ CANDIDATE ──空满 T1──▶ OWNER ──宿主回来满 T2──▶ DRAINING ──▶ STANDBY
 *     └──有 owner──▶ STANDBY ◀──────────── 交回完成 ────────────────────────────┘
 *
 * 参数（env 可覆盖）：T1=90s 接管前要连续空多久；T2=30s 交回前要连续确认多久；
 * minHold=120s 交回后多久内不再抢；每小时最多 3 次切换（超了停在 STANDBY 并告警）；
 * drain 上限 60s（等 in-flight 回合）。
 *
 * 这里只做判断、不碰进程：调用方（control/bin/qq-harness-supervisor.mjs）执行 actions。
 */
import { KIND_PRIORITY } from '../../lib/harness-heartbeat.js'

export const SUPERVISOR_STATES = ['probe', 'standby', 'candidate', 'owner', 'draining', 'stopped']

export const DEFAULT_PARAMS = {
  t1Seconds: 90,
  t2Seconds: 30,
  minHoldSeconds: 120,
  switchesPerHour: 3,
  pollSeconds: 5,
  drainSeconds: 60,
}

/** 从环境变量读参数（容器 compose 里给出，宿主可覆盖）。 */
export function paramsFromEnv(env = process.env) {
  const num = (key, fallback) => {
    const value = Number(env[key])
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return {
    t1Seconds: num('QQ_TAKEOVER_T1_SECONDS', DEFAULT_PARAMS.t1Seconds),
    t2Seconds: num('QQ_TAKEOVER_T2_SECONDS', DEFAULT_PARAMS.t2Seconds),
    minHoldSeconds: num('QQ_MIN_HOLD_SECONDS', DEFAULT_PARAMS.minHoldSeconds),
    switchesPerHour: num('QQ_SWITCHES_PER_HOUR', DEFAULT_PARAMS.switchesPerHour),
    pollSeconds: num('QQ_HARNESS_POLL_SECONDS', DEFAULT_PARAMS.pollSeconds),
    drainSeconds: num('QQ_DRAIN_SECONDS', DEFAULT_PARAMS.drainSeconds),
    mode: String(env.QQ_HARNESS_MODE ?? 'auto').trim() || 'auto',
    kind: String(env.QQ_HARNESS_KIND ?? 'container').trim() || 'container',
  }
}

/**
 * 谁更有资格持有（与 harness-heartbeat 的 electOwner 同一套规则）：
 * 优先级高者胜 → startedAt 早者胜 → instanceId 字典序小者胜。
 *
 * 为什么需要它：旧口径是"名册里 kind 优先级 >= 自己的都算竞争者"，
 * 于是 ①supervisor 会把自己起的 harness（kind 相同、startedAt 更晚）当成"宿主回来了"，
 * T2 之后自杀；②两个容器互相都把对方当竞争者 → 双双待机、谁也不服务（2026-10-12 复现）。
 */
export function outranks(candidate, self) {
  const ca = KIND_PRIORITY[candidate?.kind] ?? 0
  const cb = KIND_PRIORITY[self?.kind] ?? 0
  if (ca !== cb) return ca > cb
  const sa = Number(candidate?.startedAt) || 0
  const sb = Number(self?.startedAt) || 0
  if (sa !== sb) return sa < sb
  return String(candidate?.instanceId ?? '') < String(self?.instanceId ?? '')
}

export function createSupervisorState({ params = DEFAULT_PARAMS, now = Date.now(), kind = params.kind ?? 'container', mode = params.mode ?? 'auto' } = {}) {
  return {
    state: 'probe',
    kind,
    mode,
    since: now,
    emptySince: 0,        // 名册连续为空的起点（0 = 当前不空）
    foreignSince: 0,      // 出现更高优先级 owner 的起点
    lastSwitchAt: 0,
    switches: [],         // 最近一小时的切换时间戳
    enteredOwnerAt: 0,
    drainStartedAt: 0,
    alerts: [],
  }
}

function pruneSwitches(state, now) {
  state.switches = state.switches.filter((at) => now - at < 3_600_000)
}

/**
 * 走一拍。
 * @param {object} state createSupervisorState() 的结果（会被就地更新）
 * @param {{ roster?: object[], probe?: { available?: boolean, foreign?: object[] }, childRunning?: boolean, self?: { instanceId?: string, kind?: string, startedAt?: number } }} input
 * @param {{ now?: number, params?: object }} [options]
 * @returns {{ state: string, actions: string[], reason: string }}
 */
export function stepSupervisor(state, input = {}, { now = Date.now(), params = DEFAULT_PARAMS } = {}) {
  const actions = []
  const roster = Array.isArray(input.roster) ? input.roster : []
  const probe = input.probe ?? {}
  const childRunning = input.childRunning === true
  const want = KIND_PRIORITY[state.kind] ?? 0
  // self 缺席时退回旧口径（kind 优先级 >= 自己），保持既有调用方/单测兼容
  const self = input.self ?? null
  const others = self === null
    ? roster.filter((item) => (KIND_PRIORITY[item.kind] ?? 0) >= want)
    : roster.filter((item) => outranks(item, self))
  // container-only：假装名册里没有更高优先级实例（宿主心跳不该参与任何计时）
  const ignoreHost = state.mode === 'container-only'
  const blocker = ignoreHost === true ? null : (others.length > 0 ? others[0] : null)
  let reason = ''

  // 切换计数与冷却
  pruneSwitches(state, now)
  const switchesFull = state.switches.length >= params.switchesPerHour
  const inMinHold = state.lastSwitchAt !== 0 && now - state.lastSwitchAt < params.minHoldSeconds * 1000

  // 名册空计时
  if (blocker === null) {
    if (state.emptySince === 0) state.emptySince = now
  } else {
    state.emptySince = 0
  }
  // 被挡计时
  if (blocker !== null) {
    if (state.foreignSince === 0) state.foreignSince = now
  } else {
    state.foreignSince = 0
  }
  const emptyFor = state.emptySince === 0 ? 0 : now - state.emptySince
  const blockedFor = state.foreignSince === 0 ? 0 : now - state.foreignSince


  switch (state.state) {
    case 'probe': {
      // 首拍只做判断，不立刻接管：等一个 T1，避免开机窗口抢跑
      state.state = blocker === null || ignoreHost ? 'candidate' : 'standby'
      state.since = now
      reason = blocker === null ? '名册为空 → 进入候选（等 T1）' : `${blocker.kind} 在托管 → 待机`
      if (state.state === 'candidate' && state.emptySince === 0) state.emptySince = now
      break
    }
    case 'standby': {
      if (blocker === null) {
        state.state = 'candidate'
        state.since = now
        reason = '名册空了 → 进入候选'
      } else {
        reason = `待机：${blocker.kind} 持有托管权`
      }
      break
    }
    case 'candidate': {
      if (blocker !== null && !ignoreHost) {
        state.state = 'standby'
        state.since = now
        reason = `${blocker.kind} 回来了 → 回到待机`
        break
      }
      if (probe.available === false && state.mode === 'strict') {
        reason = 'strict 模式：探测不可用，证明不了独占 → 继续等'
        break
      }
      if (inMinHold) {
        reason = `刚交回过（minHold ${params.minHoldSeconds}s 未到）→ 继续等`
        break
      }
      if (switchesFull) {
        if (!state.alerts.includes('switches')) state.alerts.push('switches')
        reason = `一小时切换已达上限 ${params.switchesPerHour} 次 → 停在候选并告警`
        break
      }
      if (emptyFor >= params.t1Seconds * 1000) {
        state.state = 'owner'
        state.since = now
        state.enteredOwnerAt = now
        state.switches.push(now)
        state.lastSwitchAt = now
        actions.push('spawn')
        reason = `名册连续为空 ${Math.round(emptyFor / 1000)}s（≥T1）→ 接管，启动 harness`
      } else {
        reason = `候选：名册空 ${Math.round(emptyFor / 1000)}s / 需要 ${params.t1Seconds}s`
      }
      break
    }
    case 'owner': {
      if (!childRunning) {
        actions.push('spawn')
        reason = '子进程不在（刚崩过）→ 重新拉起'
      }
      if (blocker !== null) {
        if (blockedFor >= params.t2Seconds * 1000) {
          state.state = 'draining'
          state.since = now
          state.drainStartedAt = now
          state.switches.push(now)
          state.lastSwitchAt = now
          actions.push('drain')
          reason = `${blocker.kind} 回来已 ${Math.round(blockedFor / 1000)}s（≥T2）→ 交回：开始 drain`
        } else {
          reason = `${blocker.kind} 回来了（确认 ${Math.round(blockedFor / 1000)}s / ${params.t2Seconds}s）→ 继续托管`
        }
      } else {
        reason = '本实例托管中'
      }
      break
    }
    case 'draining': {
      const drained = now - state.drainStartedAt >= params.drainSeconds * 1000
      if (childRunning !== true || drained) {
        if (childRunning === true) actions.push('kill')
        state.state = 'standby'
        state.since = now
        reason = drained ? `drain 到上限 ${params.drainSeconds}s → 强制停止并回到待机` : '子进程已退出 → 交回完成，回到待机'
      } else {
        actions.push('wait')
        reason = `drain 中（${Math.round((now - state.drainStartedAt) / 1000)}s / ${params.drainSeconds}s）`
      }
      break
    }
    case 'stopped': {
      reason = '已停止'
      break
    }
    default: {
      state.state = 'probe'
      reason = `未知状态 → 回到 probe`
    }
  }

  return { state: state.state, actions, reason }
}
