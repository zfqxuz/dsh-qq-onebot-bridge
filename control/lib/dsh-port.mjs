/**
 * DSH 宿主端口的解析（[本地补丁] 2026-10-12）
 *
 * 背景：控制台和宿主是两个进程。既然已经解耦，控制台就不该"记着"宿主的端口 ——
 * 以前它只读 QQ_DSH_PORT、读不到就假定 3080，于是宿主被起在别的端口时
 * （systemd 里 `dsh web --port 3081`，或别人机器上的 3082/3083），
 * 页面就报「DSH 宿主不可用」，而机器上其实跑得好好的。
 *
 * 所以这里不写死端口，而是按"离运行事实有多近"排出候选：
 *   1. 环境变量 QQ_DSH_PORT          —— 显式指定优先（容器/compose 用这条）
 *   2. 控制台配置 qq-control.json    —— ports.host，用户显式设过就算数
 *   3. 正在跑的 dsh 进程             —— /proc/<pid>/cmdline 里的 `dsh web … --port N`
 *   4. 启动器登记的地址              —— <数据根>/state/dsh-web-url.txt
 *   5. 宿主自己打印的地址            —— <数据根>/logs/dsh-web.log（取最后一次）
 *   6. 兜底 3080                     —— 什么都没找到时才用，来源会标明是"默认值"
 * 调用方（status-page）按顺序逐个探活，取第一个真的响应的，并把来源显示在页面上；
 * 所以端口不对时页面会告诉你"我在探哪个、这个值是哪来的"，而不是干说一句不可用。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 什么都没发现时才用的兜底端口（老默认值，不是"真源"）。 */
export const DEFAULT_DSH_PORT = 3080

const URL_PORT_RE = /https?:\/\/[^\s/]*?:(\d+)\b/g

/** 取文本里**最后**一次出现的 URL 端口（日志是追加的，最后一条才是当前在跑的）。 */
export function lastUrlPort(text) {
  let found = null
  for (const match of String(text ?? '').matchAll(URL_PORT_RE)) found = Number(match[1])
  return validPort(found) ? found : null
}

function validPort(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 65535
}

/**
 * 从一条 cmdline 里认出「dsh web …」。
 * cmdline 是 NUL 分隔的；为了让测试和手工调用方便，空白分隔也认。
 * - 不是 dsh 的 web 子命令 → null（避免把别的进程的 web 参数误认进来）
 * - 是 dsh web 但没写 --port（默认端口）→ 返回 { port: null }，
 *   调用方自己决定要不要（找端口时不要，判断"宿主在不在跑/带不带代理"时要）
 */
export function parseDshCmdline(text) {
  const raw = String(text ?? '')
  const args = (raw.includes('\0') ? raw.split('\0') : raw.split(/\s+/)).filter(Boolean)
  if (args.length === 0) return null
  if (!args.some((a) => a === 'web' || a === '/web')) return null
  const looksLikeDsh = args.some((a) => /(^|\/)dsh$/.test(a) || /(^|\/)dsh\.(m?js|cjs)$/.test(a) || /@deepseek-ai\/dsh\//.test(a) || /dsh\/(bin|index)\.js$/.test(a))
  if (!looksLikeDsh) return null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const inline = /^--?port=(\d+)$/.exec(arg)
    if (inline) return { port: validPort(inline[1]) ? Number(inline[1]) : null, argv: args }
    if (arg === '--port' || arg === '-p') {
      const next = args[i + 1]
      return { port: validPort(next) ? Number(next) : null, argv: args }
    }
  }
  return { port: null, argv: args }
}

/**
 * 扫 /proc 找正在跑的 dsh 宿主进程。进程越新越靠前（同名旧进程留给候选探活去淘汰）。
 * 非 Linux（没有 /proc）时返回空数组，由调用方回落到其它来源。
 */
export function scanDshProcesses({ procRoot = '/proc', readdir = readdirSync, readFile = readFileSync, requirePort = true } = {}) {
  const found = []
  let entries = []
  try { entries = readdir(procRoot) } catch { return found }
  for (const name of entries) {
    if (!/^\d+$/.test(String(name))) continue
    let cmdline = ''
    try { cmdline = readFile(join(procRoot, String(name), 'cmdline'), 'utf8') } catch { continue }
    const parsed = parseDshCmdline(cmdline)
    if (!parsed) continue
    if (requirePort && parsed.port === null) continue
    let started = 0
    try {
      // /proc/<pid>/stat 第 22 个字段是启动时刻；comm 里有空格，所以按最后一个 ')' 切
      const statText = String(readFile(join(procRoot, String(name), 'stat'), 'utf8'))
      const rest = statText.slice(statText.lastIndexOf(')') + 2).split(/\s+/)
      started = Number(rest[19] ?? 0) || 0
    } catch { /* 拿不到就用 0 */ }
    found.push({ pid: Number(name), port: parsed.port, started })
  }
  found.sort((a, b) => b.started - a.started || b.pid - a.pid)
  return found
}

function readTextSafe(file, readFile) {
  if (!file) return ''
  try { return String(readFile(file, 'utf8')) } catch { return '' }
}

/** 从 qq-control.json 里取用户显式写过的 ports.host（没有文件 / 没写就算没配）。 */
export function configuredHostPort(configFile, readFile = readFileSync) {
  const text = readTextSafe(configFile, readFile)
  if (!text) return null
  try {
    const raw = JSON.parse(text)
    return validPort(raw?.ports?.host) ? Number(raw.ports.host) : null
  } catch { return null }
}

/**
 * 按可信度排出候选端口（已去重，每项带中文来源说明）。
 * 纯函数 + 依赖注入，测试不需要真机器。
 */
export function dshPortCandidates({
  env = process.env,
  dataRoot = '',
  configFile = '',
  procRoot = '/proc',
  readdir = readdirSync,
  readFile = readFileSync,
} = {}) {
  const list = []
  const add = (port, source) => {
    if (!validPort(port)) return
    const n = Number(port)
    if (list.some((item) => item.port === n)) return
    list.push({ port: n, source })
  }

  add(env.QQ_DSH_PORT, '环境变量 QQ_DSH_PORT')
  add(configuredHostPort(configFile, readFile), '控制台配置 qq-control.json')
  for (const proc of scanDshProcesses({ procRoot, readdir, readFile })) {
    add(proc.port, `运行中的 dsh 进程（pid ${proc.pid}）`)
  }
  if (dataRoot) {
    add(lastUrlPort(readTextSafe(join(dataRoot, 'state', 'dsh-web-url.txt'), readFile)), '启动器登记的地址（state/dsh-web-url.txt）')
    add(lastUrlPort(readTextSafe(join(dataRoot, 'logs', 'dsh-web.log'), readFile)), '宿主日志里的地址（logs/dsh-web.log）')
  }
  add(DEFAULT_DSH_PORT, '默认值')
  return list
}
