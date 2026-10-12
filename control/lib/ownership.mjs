/**
 * [本地补丁] 控制台的"会话所有权"读取（SPEC-ownership-and-takeover §3 L1/L3.5）。
 *
 * 控制台与 harness 是两个进程（容器部署里还是两个 PID 命名空间），所以它不猜、只读：
 *   · `state/harness/*.json` —— 每个 harness 实例的心跳，选主规则与插件/CLI 同源；
 *   · `state/harness-standby.json` —— 容器 entrypoint 在"宿主优先、暂不启动"时留下的说明。
 * 读不到目录不算错误（没装新版/还没实例登记），返回 available:false 让界面说清楚。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { electOwner, readHeartbeats, summarizeOwner } from '../../lib/harness-heartbeat.js'

/** 读一份 JSON；坏文件/不存在返回 null（控制台不因为一个坏文件整页失败）。 */
function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {string} dataRoot 数据根（容器里是 /data/qqbot，宿主上是 ~/qqbot）
 * @param {{ now?: number, ttlSeconds?: number, readdir?: Function, read?: Function, exists?: Function }} [io]
 * @returns {{ available:boolean, dir:string, at:number, owner:object|null, ownerText:string,
 *            roster:object[], stale:number, standby:object|null, note:string }}
 */
export function readOwnership(dataRoot, io = {}) {
  const now = Number(io.now) || Date.now()
  const dir = join(String(dataRoot), 'state', 'harness')
  const { fresh, stale } = readHeartbeats(dir, { now, ...io })
  const owner = electOwner(fresh)
  const standby = readJsonSafe(join(String(dataRoot), 'state', 'harness-standby.json'))
  const supervisor = readJsonSafe(join(String(dataRoot), 'state', 'harness-supervisor.json'))
  const roster = fresh
    .map((item) => ({
      instanceId: item.instanceId, kind: item.kind, pid: item.pid, port: item.port,
      version: item.version, ageSeconds: item.ageSeconds, workspace: item.workspace,
      isOwner: owner !== null && owner.instanceId === item.instanceId,
    }))
    .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.kind.localeCompare(b.kind))
  let note = ''
  if (supervisor !== null && roster.length === 0 && standby === null && supervisor.state !== 'owner') {
    note = `接管状态机：${supervisor.state}（${supervisor.reason}）`
  } else if (roster.length === 0 && standby === null) note = '名册为空：没有 harness 登记心跳（旧版本插件不会写）'
  else if (standby !== null && roster.length === 0) note = '容器处于待机：宿主在托管，harness 未启动'
  else if (standby !== null) note = '容器曾在待机，现在已有实例登记'
  return {
    available: roster.length > 0 || standby !== null || supervisor !== null,
    dir,
    at: now,
    owner,
    ownerText: summarizeOwner(owner, {}),
    roster,
    stale,
    supervisor: supervisor === null ? null : {
      at: Number(supervisor.at) || 0,
      state: String(supervisor.state ?? ''),
      reason: String(supervisor.reason ?? ''),
      since: Number(supervisor.since) || 0,
      childPid: Number(supervisor.childPid) || 0,
      switches: Number(supervisor.switches) || 0,
      alerts: Array.isArray(supervisor.alerts) ? supervisor.alerts : [],
      registryDir: String(supervisor.registryDir ?? ''),
      probe: supervisor.probe === undefined || supervisor.probe === null ? null : {
        available: supervisor.probe.available === true,
        count: Number(supervisor.probe.count) || 0,
        reason: String(supervisor.probe.reason ?? ''),
      },
    },
    standby: standby === null ? null : {
      at: Number(standby.at) || 0,
      mode: String(standby.mode ?? ''),
      kind: String(standby.kind ?? ''),
      modeEnv: String(standby.modeEnv ?? ''),
      reason: String(standby.reason ?? ''),
      ageSeconds: Number(standby.at) ? Math.max(0, Math.round((now - Number(standby.at)) / 1000)) : 0,
    },
    note,
  }
}
