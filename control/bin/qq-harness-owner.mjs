#!/usr/bin/env node
/**
 * [本地补丁] 托管权 CLI（SPEC-ownership-and-takeover §3 L1）——给容器 entrypoint 与宿主启动器
 * 共用的一把"谁该起 harness"的尺子。规则与插件内部完全同源（lib/harness-heartbeat.js）。
 *
 *   node control/bin/qq-harness-owner.mjs                      # 打印名册与当前 owner
 *   node control/bin/qq-harness-owner.mjs --kind container --check   # 能不能接手：exit 0 / 2
 *   node control/bin/qq-harness-owner.mjs --kind host --claim        # 写自己的心跳（启动窗口）
 *   node control/bin/qq-harness-owner.mjs --kind host --release      # 删自己的心跳（优雅退出）
 *
 * 环境：QQ_HARNESS_STATE_DIR 指定名册目录（默认 $DSH_HOME/state/harness 或 ~/.dsh/state/harness）；
 *      QQ_HARNESS_KIND 给插件用（这里用 --kind）。
 * 退出码：0 = 允许/成功；2 = 被别人占着（--check）；3 = 用法或环境错误。
 */
import { existsSync } from 'node:fs'
import { electOwner, canTakeOver, harnessStateDir, readHeartbeats, removeHeartbeat, summarizeOwner, writeHeartbeat, buildHeartbeat, DEFAULT_HEARTBEAT_SECONDS } from '../../lib/harness-heartbeat.js'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag.startsWith('--') ? flag : `--${flag}`)
const argOf = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const kind = String(argOf('kind', 'host')).toLowerCase()
if (!['host', 'container', 'desktop'].includes(kind)) {
  console.error(`✖ 未知 --kind ${kind}（可用 host / container / desktop）`)
  process.exit(3)
}
const dir = String(argOf('state-dir', harnessStateDir())).trim()
const instanceId = String(argOf('instance', `${kind}-${process.pid}`))
const port = Number(argOf('port', '0')) || 0
const asJson = has('json')

/** 打印并返回当前局面。 */
function snapshot() {
  const { fresh, stale } = readHeartbeats(dir)
  const owner = electOwner(fresh)
  return { dir, fresh, stale, owner }
}

if (has('check')) {
  const verdict = canTakeOver(dir, { kind })
  if (asJson) console.log(JSON.stringify({ dir, kind, ...verdict, ttlSeconds: undefined }, null, 2))
  else console.log(`${verdict.ok ? '✔' : '✖'} ${kind} 可以接手吗：${verdict.ok ? '可以' : '不行'} —— ${verdict.reason}`)
  process.exit(verdict.ok ? 0 : 2)
}

if (has('claim')) {
  const verdict = canTakeOver(dir, { kind })
  if (verdict.ok !== true) {
    console.error(`✖ 不写心跳：${verdict.reason}`)
    process.exit(2)
  }
  const record = buildHeartbeat({ instanceId, kind, port, home: dir, workspace: process.cwd(), startedAt: Date.now() })
  const file = writeHeartbeat(dir, record)
  if (asJson) console.log(JSON.stringify({ dir, file, record }, null, 2))
  else console.log(`✔ 已登记 ${kind} 心跳：${file}（${DEFAULT_HEARTBEAT_SECONDS} 秒一跳由 harness 插件接续；本进程退出后由 TTL 过期）`)
  process.exit(0)
}

if (has('release')) {
  const ok = removeHeartbeat(dir, instanceId)
  console.log(ok ? `✔ 已移除本实例心跳（${instanceId}）` : `· 心跳本来就不在（${instanceId}）`)
  process.exit(0)
}

const snap = snapshot()
if (asJson) {
  console.log(JSON.stringify({ ...snap, kind, selfId: instanceId }, null, 2))
  process.exit(0)
}
console.log(`名册目录：${snap.dir}${existsSync(snap.dir) ? '' : '（不存在 = 还没有任何实例登记）'}`)
console.log(`当前 owner：${summarizeOwner(snap.owner, { selfId: instanceId })}`)
if (snap.fresh.length === 0) console.log('（名册为空：没有别的 harness 在跑）')
for (const item of snap.fresh) {
  console.log(`· ${item.kind} ${item.instanceId} pid=${item.pid} 端口=${item.port || '-'} 心跳=${item.ageSeconds}s 版本=${item.version || '-'}`)
}
if (snap.stale > 0) console.log(`（另有 ${snap.stale} 条过期心跳已忽略）`)
console.log(`TTL ${15} 秒；本实例若要以 ${kind} 身份接手，用 --kind ${kind} --check 先问一句。`)
