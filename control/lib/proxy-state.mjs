/**
 * 「宿主现在到底走代理还是直连」的判定（[本地补丁] 2026-10-12）
 *
 * 为什么不能只看 <数据根>/state/proxy.json：
 *   那份状态文件是**别人**写的 —— 容器里由 entrypoint 的探活循环写，宿主模式下由 watchdog 写。
 *   谁没在跑，它就一直是上次那条陈旧记录。2026-10-12 实测过两次：
 *     · 宿主明明是带代理起的，状态文件却写着 direct（于是日志报了"代理已恢复"的假消息）；
 *     · 反过来也有：容器停机那一刻写进 direct，之后宿主起来了、页面还显示"直连"。
 *
 * 所以判定按"离运行事实有多近"来：
 *   1. 宿主进程的环境变量（/proc/<pid>/environ）—— 真正的 ground truth，DSH 就是按它决定代理策略的；
 *   2. 状态文件里最近一次探活记录 —— 只在读不到进程环境时兜底，并且**标注它是旧的**。
 * 两者不一致时要把差异说出来（stale=true），别让页面拿旧值当现状。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { scanDshProcesses } from './dsh-port.mjs'

const PROXY_RE = /^(https?_proxy|all_proxy)=(.+)$/i

/** 读最近一次探活记录（可能过期，调用方要标出来）。 */
export function readProxyState(dataRoot, { readFile = readFileSync } = {}) {
  try { return JSON.parse(readFile(join(dataRoot, 'state', 'proxy.json'), 'utf8')) } catch { return null }
}

/**
 * 从正在跑的宿主进程环境里读代理设置 —— 这是"实际用了什么"的唯一可信来源。
 * 返回 { mode: 'proxy'|'direct'|'unknown', pid, proxy }。
 */
export function detectHostProxy({ procRoot = '/proc', readdir = readdirSync, readFile = readFileSync } = {}) {
  for (const proc of scanDshProcesses({ procRoot, readdir, readFile, requirePort: false })) {
    let raw = ''
    try { raw = readFile(join(procRoot, String(proc.pid), 'environ'), 'utf8') } catch { continue }
    for (const entry of String(raw).split('\0')) {
      const hit = PROXY_RE.exec(entry)
      if (hit) return { mode: 'proxy', pid: proc.pid, proxy: hit[2] }
    }
    // 找到宿主了、但环境里没有代理变量 → 它就是直连起的（这是结论，不是"不知道"）
    return { mode: 'direct', pid: proc.pid, proxy: '' }
  }
  return { mode: 'unknown', pid: 0, proxy: '' }
}

/**
 * 给页面用的合并视图：mode/来源以运行事实为准，探活记录单独带着（并标明新旧）。
 */
export function describeProxy(dataRoot, options = {}) {
  const record = readProxyState(dataRoot, options)
  const live = detectHostProxy(options)
  const mode = live.mode !== 'unknown' ? live.mode : (record?.mode ?? 'unknown')
  const modeSource = live.mode !== 'unknown'
    ? `运行中的 dsh 进程环境（pid ${live.pid}）`
    : (record ? `状态文件（${record.source || '未知来源'}）` : '未知')
  const proxy = live.proxy || record?.proxy || ''
  const probe = record
    ? { code: record.code ?? '', at: record.at ?? 0, healthy: record.healthy === true, source: record.source ?? '' }
    : null
  // 状态文件和运行事实打架 → 让页面说清楚"这条记录是旧的"
  const stale = Boolean(record && live.mode !== 'unknown' && record.mode && record.mode !== live.mode)
  const healthy = mode === 'proxy' ? (probe ? probe.healthy : true) : true
  return { ...(record ?? {}), mode, modeSource, proxy, probe, stale, healthy }
}
