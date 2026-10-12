/**
 * [本地补丁] 控制台「会话所有权」读取（SPEC-ownership-and-takeover §3 L1）验收测试。
 *
 * 控制台与 harness 是两个进程，它只读共享数据根里的名册与待机说明。覆盖：
 *   · 空目录：available=false，并说清"没有实例登记"；
 *   · 只有待机说明（容器被宿主挡下）：standby 解析出来，note 说明是待机；
 *   · 宿主 + 容器同时登记：owner 是宿主，roster 里 owner 排第一且 isOwner 正确；
 *   · 过期心跳只计入 stale、不进 roster；坏 JSON 被忽略；
 *   · 数据根不存在也不抛错。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHeartbeat, writeHeartbeat } from '../lib/harness-heartbeat.js'
import { readOwnership } from '../control/lib/ownership.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-ownership-console-'))
const dataRoot = join(root, 'qqbot')
const hbDir = join(dataRoot, 'state', 'harness')
const now = Date.now()

// 1) 空数据根
const empty = readOwnership(join(root, 'missing-root'), { now })
check('数据根不存在：available=false 且不抛错', empty.available === false && empty.roster.length === 0, empty.note)

// 2) 只有待机说明
mkdirSync(hbDir, { recursive: true })
writeFileSync(join(dataRoot, 'state', 'harness-standby.json'), JSON.stringify({
  at: now - 5_000, mode: 'standby', kind: 'container', modeEnv: 'auto', reason: '✖ host 实例持有托管权（pid 9）',
}), 'utf8')
const standbyOnly = readOwnership(dataRoot, { now })
check('只有待机说明：available=true', standbyOnly.available === true)
check('待机说明被解析（含年龄与原因）',
  standbyOnly.standby?.mode === 'standby' && standbyOnly.standby.ageSeconds === 5 && standbyOnly.standby.reason.includes('host'),
  JSON.stringify(standbyOnly.standby))
check('待机时 note 说明"容器处于待机"', standbyOnly.note.includes('待机'), standbyOnly.note)

// 3) 宿主 + 容器同时登记（宿主优先）
writeHeartbeat(hbDir, buildHeartbeat({ instanceId: 'host-1', kind: 'host', pid: 11, port: 3080, startedAt: now - 9_000, now, version: '0.7.3' }))
writeHeartbeat(hbDir, buildHeartbeat({ instanceId: 'container-1', kind: 'container', pid: 22, port: 0, startedAt: now - 1_000, now, version: '0.7.3' }))
const both = readOwnership(dataRoot, { now })
check('宿主在时 owner 是宿主', both.owner?.instanceId === 'host-1', both.ownerText)
check('roster 有两条且 owner 排第一', both.roster.length === 2 && both.roster[0].isOwner === true && both.roster[0].kind === 'host',
  JSON.stringify(both.roster.map((r) => [r.kind, r.isOwner])))
check('已不是待机状态时 note 如实说明', both.note.includes('曾') || both.note === '', both.note)

// 4) 过期与坏文件
writeHeartbeat(hbDir, buildHeartbeat({ instanceId: 'old-1', kind: 'container', startedAt: now - 600_000, now: now - 600_000 }))
writeFileSync(join(hbDir, 'broken.json'), '{ nope', 'utf8')
const mixed = readOwnership(dataRoot, { now })
check('过期心跳只计入 stale、不进 roster', mixed.roster.length === 2 && mixed.stale >= 1, `roster=${mixed.roster.length} stale=${mixed.stale}`)
check('坏 JSON 被忽略（不影响其余读取）', mixed.roster.some((r) => r.instanceId === 'host-1'))

// 5) 容器独占（宿主不在）
rmSync(join(hbDir, 'host-1.json'), { force: true })
const containerOnly = readOwnership(dataRoot, { now })
check('宿主退出后 owner 变成容器', containerOnly.owner?.kind === 'container', containerOnly.ownerText)

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
