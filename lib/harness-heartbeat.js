/**
 * [本地补丁] harness 心跳与"托管权"选主（SPEC-ownership-and-takeover §3 L1）。
 *
 * 为什么需要：宿主 dsh 与容器 harness 可能共用同一份 DSH home，而 DSH 的会话写权是
 * 跨进程内核锁——谁先拿到算谁的。要把"该不该起 harness"变成可判定的问题，就得有一个
 * 所有参与者都看得见、且规则确定的名册。名册放在**被争用的资源里**（DSH home 下的
 * state/harness/），因此 Windows 没有 flock、macOS 没有 /proc、容器探不到宿主进程，
 * 都不影响参与者之间的仲裁。
 *
 * 本文件只做四件事，全部是纯函数或纯 IO，便于单测：
 *   · 心跳记录的构造与落盘（每 5 秒重写一次）；
 *   · 读取名册（过期条目忽略、坏文件忽略）；
 *   · 选主（kind 优先级 → startedAt 早者 → instanceId 字典序）；
 *   · 判断"某个 kind 现在能不能接手"。
 *
 * 参与者：宿主启动器、容器 entrypoint（`control/bin/qq-harness-owner.mjs` 调用这里）、
 * 以及插件自身（TUI / 桌面端没有监听端口，只能靠插件写心跳被看见）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/** kind 的接管优先级：数字大者优先（宿主优先是产品决定，见 SPEC 决策 D1）。 */
export const KIND_PRIORITY = { container: 1, desktop: 2, host: 3 }

/** 默认心跳间隔与过期时间（秒）；TTL 至少 3 个心跳周期，避免抖动误判。 */
export const DEFAULT_HEARTBEAT_SECONDS = 5
export const DEFAULT_TTL_SECONDS = 15

/**
 * 名册目录，按“谁最可能是共享的”排序：
 *   ① QQ_HARNESS_STATE_DIR（显式指定，测试与自定义部署用）
 *   ② $QQ_DATA_ROOT/state/harness（部署里宿主与容器挂的是同一份数据根）
 *   ③ $DSH_HOME/state/harness（宿主安装：宿主与容器共用同一份 DSH home）
 *   ④ ~/.dsh/state/harness（兜底）
 * 插件与 CLI（control/bin/qq-harness-owner.mjs）都走这一个函数，避免两边算出不同的名册目录。
 */
export function harnessStateDir({ env = process.env } = {}) {
  const explicit = String(env.QQ_HARNESS_STATE_DIR ?? '').trim()
  if (explicit !== '') return explicit
  const dataRoot = String(env.QQ_DATA_ROOT ?? '').trim()
  if (dataRoot !== '') return join(dataRoot, 'state', 'harness')
  const home = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'state', 'harness')
}

/**
 * 清理过期很久的心跳文件（默认 1 小时）：只删“早就死了、也没人清”的残留，
 * 避免长期运行/反复测试把名册目录撑大。返回删掉的文件数。
 */
export function sweepStaleHeartbeats(dir, {
  now = Date.now(), maxAgeSeconds = 3600, readdir = readdirSync, read = readFileSync, rm = rmSync, exists = existsSync,
} = {}) {
  if (exists(dir) !== true) return 0
  let names = []
  try { names = readdir(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (typeof name !== 'string' || name.endsWith('.json') !== true) continue
    try {
      const record = JSON.parse(read(join(dir, name), 'utf8'))
      const at = Number(record?.heartbeatAt)
      if (!Number.isFinite(at) || now - at <= maxAgeSeconds * 1000) continue
      rm(join(dir, name), { force: true })
      removed += 1
    } catch { /* 坏文件留着给人看 */ }
  }
  return removed
}

/** 猜本实例的 kind：env 优先；容器里常见标记退而求其次。 */
export function detectKind({ env = process.env, exists = existsSync, platform = process.platform } = {}) {
  const explicit = String(env.QQ_HARNESS_KIND ?? '').trim().toLowerCase()
  if (explicit === 'host' || explicit === 'container' || explicit === 'desktop') return explicit
  if (String(env.QQ_BRIDGE_DIR ?? '').trim() !== '' || exists('/.dockerenv') || exists('/data/qqbot')) return 'container'
  if (platform === 'darwin' && String(env.DSH_DESKTOP ?? '').trim() !== '') return 'desktop'
  return 'host'
}

/** 心跳文件名（instanceId 已由调用方消毒）。 */
export function heartbeatFile(dir, instanceId) {
  return join(dir, `${String(instanceId).replace(/[^\w.-]/g, '_')}.json`)
}

/** 组装一条心跳记录（字段固定，方便人工排查与脚本消费）。 */
export function buildHeartbeat({
  instanceId, kind, pid = process.pid, port = 0, home = '', workspace = '',
  startedAt, now = Date.now(), version = '', host = hostname(), platform = process.platform,
  ownedBy = '',
}) {
  return {
    instanceId: String(instanceId),
    kind: KIND_PRIORITY[kind] === undefined ? 'host' : kind,
    pid: Number(pid) || 0,
    port: Number(port) || 0,
    home: String(home ?? ''),
    workspace: String(workspace ?? ''),
    host: String(host ?? ''),
    platform: String(platform ?? ''),
    startedAt: Number(startedAt) || now,
    heartbeatAt: now,
    version: String(version ?? ''),
    // 谁起的我（supervisor 的实例 id，见 control/bin/qq-harness-supervisor.mjs）：
    // supervisor 据此把自己起的 harness 从"竞争者"里摘出去，否则会把自己 kill 掉。
    ownedBy: String(ownedBy ?? ''),
  }
}

/** 写一条心跳（原子：先写临时文件再 rename 之外，直接覆盖也够——内容只有本进程写）。 */
export function writeHeartbeat(dir, record, { mkdir = mkdirSync, write = writeFileSync } = {}) {
  mkdir(dir, { recursive: true })
  const file = heartbeatFile(dir, record.instanceId)
  write(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return file
}

/** 删掉自己的心跳（优雅退出时调用；崩了也没关系，TTL 到期即失效）。 */
export function removeHeartbeat(dir, instanceId, { rm = rmSync, exists = existsSync } = {}) {
  const file = heartbeatFile(dir, instanceId)
  try {
    if (exists(file) !== true) return false
    rm(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 读名册：只返回**新鲜**的记录（age <= ttlMs），坏文件与缺字段的一律跳过。
 * @returns {{ fresh: object[], stale: number, dir: string }}
 */
export function readHeartbeats(dir, {
  now = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS,
  readdir = readdirSync, read = readFileSync, exists = existsSync,
} = {}) {
  const ttlMs = Math.max(1, Number(ttlSeconds) || DEFAULT_TTL_SECONDS) * 1000
  const fresh = []
  let stale = 0
  if (exists(dir) !== true) return { fresh, stale, dir }
  let names = []
  try {
    names = readdir(dir)
  } catch {
    return { fresh, stale, dir }
  }
  for (const name of names) {
    if (typeof name !== 'string' || name.endsWith('.json') !== true) continue
    let record = null
    try {
      record = JSON.parse(read(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    if (typeof record.instanceId !== 'string' || record.instanceId === '') continue
    if (KIND_PRIORITY[record.kind] === undefined) continue
    const at = Number(record.heartbeatAt)
    if (!Number.isFinite(at)) continue
    if (now - at > ttlMs) { stale += 1; continue }
    fresh.push({ ...record, ageSeconds: Math.max(0, Math.round((now - at) / 1000)) })
  }
  return { fresh, stale, dir }
}

/**
 * 选主：kind 优先级高者胜；同级 startedAt 早者胜；再平票比 instanceId（保证各方算出同一答案）。
 * @returns {object|null} 名册为空时返回 null
 */
export function electOwner(fresh) {
  if (!Array.isArray(fresh) || fresh.length === 0) return null
  const ranked = [...fresh].sort((a, b) => {
    const pa = KIND_PRIORITY[a.kind] ?? 0
    const pb = KIND_PRIORITY[b.kind] ?? 0
    if (pa !== pb) return pb - pa
    const sa = Number(a.startedAt) || 0
    const sb = Number(b.startedAt) || 0
    if (sa !== sb) return sa - sb
    return String(a.instanceId).localeCompare(String(b.instanceId))
  })
  return ranked[0]
}

/**
 * 指定 kind 现在能不能接手（容器/宿主启动器在起 harness 之前问这一句）。
 * @returns {{ ok: boolean, reason: string, owner: object|null, fresh: object[] }}
 */
export function canTakeOver(dir, { kind, now = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS, ...io } = {}) {
  const read = readHeartbeats(dir, { now, ttlSeconds, ...io })
  const owner = electOwner(read.fresh)
  const want = KIND_PRIORITY[kind] ?? 0
  if (owner === null) return { ok: true, reason: '名册为空（没有别的 harness 在跑）', owner: null, fresh: read.fresh }
  const ownerRank = KIND_PRIORITY[owner.kind] ?? 0
  if (ownerRank > want) {
    return { ok: false, reason: `${owner.kind} 实例持有托管权（pid ${owner.pid}${owner.port ? `, 端口 ${owner.port}` : ''}，心跳 ${owner.ageSeconds} 秒前）`, owner, fresh: read.fresh }
  }
  if (ownerRank === want) {
    return { ok: false, reason: `同级实例 ${owner.instanceId} 先到（pid ${owner.pid}，心跳 ${owner.ageSeconds} 秒前）`, owner, fresh: read.fresh }
  }
  return { ok: true, reason: `现存 ${owner.kind} 实例优先级低于本实例（${kind}）`, owner, fresh: read.fresh }
}

/** 名册的人话摘要（/health、/handoff、控制台共用）。 */
export function summarizeOwner(owner, { selfId = '' } = {}) {
  if (owner === null) return '无（名册为空）'
  const who = selfId !== '' && owner.instanceId === selfId ? '本实例' : `${owner.kind} 实例`
  const meta = [`pid ${owner.pid}`]
  if (owner.port) meta.push(`端口 ${owner.port}`)
  if (Number.isFinite(Number(owner.ageSeconds))) meta.push(`心跳 ${owner.ageSeconds} 秒前`)
  return `${who}（${meta.join('，')}）`
}
