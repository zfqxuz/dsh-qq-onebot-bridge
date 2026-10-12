/**
 * 状态台的数据面（[本地补丁 阶段0] 2026-10-12）
 *
 * 用户需求：WSL 开机后自动打开一个本地控制台，能看到
 *   ① 系统状态（宿主/容器/磁盘/版本）
 *   ② QQ 桥接细节（连接状态、会话、trace、代理状态、watchdog 事故）
 *   ③ 扫码登录 NapCat（二维码 + 免手抄 token 的 WebUI 入口）
 * 这里只负责**收集数据**，HTTP 路由与鉴权在 acl-console.mjs（同一个服务、同一套 token）。
 *
 * 依赖全部是只读动作：读 state/log 文件、docker ps、TCP 探端口；二维码**宿主文件优先**（没有 Docker 的
 * 机器上 NapCat 是原生安装的，二维码就在本机），容器部署才走 docker cp 兜底。
 * 唯一的写动作是把二维码拷到本机缓存目录（<dataRoot>/state/napcat-qrcode.png）。
 */
import { execFile } from 'node:child_process'
import { readOwnership } from './ownership.mjs'
import { detectModelCredentials } from './model-credentials.mjs'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statfsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import * as nodeHttp from 'node:http'
const require_http = () => nodeHttp
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataRoot as resolveDataRoot, napcatConfigDir as resolveNapcatConfigDir, restartScript as resolveRestartScript, dshVersion } from './paths.mjs'
import { detectPaths, loadControlConfig } from './config.mjs'
import { DEFAULT_DSH_PORT, dshPortCandidates } from './dsh-port.mjs'
import { describeProxy } from './proxy-state.mjs'

const DATA_ROOT = resolveDataRoot
const CONFIG_FILE = process.env.QQ_CONTROL_CONFIG || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'qq-control.json')

export function statusDefaults(overrides = {}) {
  // 宿主端口不写死：排出候选（env → harness 容器 → 配置 → 运行中的进程 → 登记的地址 → 日志 → 默认值），
  // 真正"选哪个"留给 collectStatus 探活决定（见 dsh-port.mjs 的注释）。
  const candidates = dshPortCandidates({ env: process.env, dataRoot: DATA_ROOT, configFile: CONFIG_FILE })
  const fallback = candidates[0] ?? { port: DEFAULT_DSH_PORT, source: '默认值' }
  return {
    dataRoot: DATA_ROOT,
    napcatContainer: process.env.QQ_NAPCAT_CONTAINER || 'napcat',
    napcatConfigDir: resolveNapcatConfigDir,
    napcatWebuiPort: Number(process.env.QQ_NAPCAT_WEBUI_PORT || 6099),
    bridgePort: Number(process.env.QQ_BRIDGE_PORT || 6700),
    dshPort: fallback.port,
    dshPortSource: fallback.source,
    dshPortCandidates: candidates,
    // 探活目标主机：host 网络下都是 127.0.0.1；compose 网络（Windows/Mac 的 Docker Desktop
    // 默认就是这种）下要填服务名，否则端口探测永远显示不可用。
    napcatHost: process.env.QQ_NAPCAT_HOST || '127.0.0.1',
    bridgeHost: process.env.QQ_BRIDGE_HOST || '127.0.0.1',
    dshHost: process.env.QQ_DSH_HOST || '127.0.0.1',
    // WebUI 链接是给**浏览器**点的，所以它用宿主侧地址（发布端口 = 127.0.0.1）
    webuiUrlHost: process.env.QQ_NAPCAT_WEBUI_URL_HOST || '127.0.0.1',
    restartScript: resolveRestartScript,
    ...overrides,
  }
}

function run(command, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? '') })
    })
  })
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function tailLines(file, count) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    return lines.slice(-count)
  } catch { return [] }
}

function tailJsonl(file, count) {
  return tailLines(file, count).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}

/** TCP 探端口（NapCat WebUI / 桥接 6700 这类"在不在听"的判据）。 */
export function tcpProbe(port, { host = '127.0.0.1', timeout = 900 } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let done = false
    const finish = (value) => { if (!done) { done = true; socket.destroy(); resolve(value) } }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * HTTP 可用性探测：比"端口在听"更强的证据。
 * 判定标准按服务类型定：DSH WebUI 期望 200/401（401 也说明服务在正常应答），
 * NapCat WebUI 期望 2xx/3xx；桥接 6700 是 WebSocket 服务，用 TCP + 收到的首行（Upgrade Required）判断。
 */
export function httpProbe({ url, timeout = 1500, expect = (code) => code > 0 && code < 500 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const req = require_http().get(url, { timeout }, (res) => {
      res.resume()
      const code = res.statusCode ?? 0
      resolve({ ok: expect(code), code, ms: Date.now() - started })
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 0, ms: Date.now() - started, reason: '超时' }) })
    req.on('error', (error) => resolve({ ok: false, code: 0, ms: Date.now() - started, reason: String(error?.code ?? error?.message ?? error) }))
  })
}

/** NapCat WebUI 地址：读 webui.json 的 token 拼上（前端会自己算 hash 登录，见 bridge 侧注释）。 */
export function napcatWebUiUrl({ napcatConfigDir = statusDefaults().napcatConfigDir, napcatWebuiPort = statusDefaults().napcatWebuiPort, host = statusDefaults().webuiUrlHost } = {}) {
  let token = ''
  try { token = String(readJsonSafe(join(napcatConfigDir, 'webui.json'))?.token ?? '') } catch { /* 读不到就退回裸地址 */ }
  const base = `http://${host}:${napcatWebuiPort}/webui/`
  return token === '' ? base : `${base}?token=${encodeURIComponent(token)}`
}

/**
 * 宿主模式下 NapCat 原生安装（没有 Docker）时二维码的候选路径：**本机文件**就在那儿，
 * 不需要 docker cp。按可信度排：
 *   1. 控制台配置里的 napcatQr（用户在页面上填过就算数）
 *   2. NapCat 启动脚本同级的 cache/qrcode.png（Windows 一键包就是这个布局，detectPaths 已解析）
 *   3. 环境变量 QQ_NAPCAT_QR（宿主安装脚本可以塞进来）
 *   4. 数据根下的 napcat-cache/qrcode.png（容器部署把宿主的 cache 目录挂在数据根里时成立）
 * 只返回真实存在的文件。
 */
export function hostQrCandidates({ configFile = CONFIG_FILE, dataRoot = DATA_ROOT, env = process.env } = {}) {
  const out = []
  try {
    // loadControlConfig 已经把 detectPaths 跑过一遍：napcatQr / napcatBat 都解析成绝对路径了
    const { config } = loadControlConfig(configFile, { env })
    if (config?.napcatQr) out.push(config.napcatQr)
  } catch { /* 配置读不了就只走下面两条 */ }
  if (env.QQ_NAPCAT_QR) out.push(String(env.QQ_NAPCAT_QR))
  if (dataRoot) out.push(join(dataRoot, 'napcat-cache', 'qrcode.png'))
  const seen = new Set()
  return out.filter((p) => {
    if (!p || seen.has(p)) return false
    seen.add(p)
    return existsSync(p)
  })
}

/**
 * 取 NapCat 二维码到本机缓存，返回 { file, source, ageSeconds, bytes }。
 *
 * 来源两条路，**宿主文件优先**（没 Docker 的机器上这才是唯一可行的那条）：
 *   · 宿主文件：hostQrCandidates()（配置的 napcatQr / NapCat 安装目录 / QQ_NAPCAT_QR / 数据根缓存）
 *   · 容器：docker cp <容器>:<容器内路径>（容器部署，10 秒内不重复拷）
 * 两条都失败时，reason 里会写清"都找过哪些地方"，而不是只说一句拿不到。
 */
export async function fetchQrImage({ dataRoot = DATA_ROOT, napcatContainer = 'napcat', containerPath = '/app/napcat/cache/qrcode.png', configFile = CONFIG_FILE, env = process.env, runCommand = run } = {}) {
  const stateDir = join(dataRoot, 'state')
  const target = join(stateDir, 'napcat-qrcode.png')
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建不了 ${stateDir}：${String(error?.message ?? error)}` }
  }

  // 1) 宿主文件（Native 安装 / 数据根里的 cache 目录）
  const tried = []
  for (const source of hostQrCandidates({ configFile, dataRoot, env })) {
    tried.push(`宿主文件 ${source}`)
    try {
      copyFileSync(source, target)
      const stat = statSync(target)
      return { ok: true, file: target, source: `宿主文件 ${source}`, ageSeconds: Math.round((Date.now() - stat.mtimeMs) / 1000), bytes: stat.size }
    } catch (error) {
      tried.push(`（拷贝失败：${String(error?.message ?? error)}）`)
    }
  }

  // 2) 容器（docker cp）
  tried.push(`容器 ${napcatContainer}:${containerPath}`)
  try {
    const fresh = existsSync(target) && (Date.now() - statSync(target).mtimeMs) < 10_000
    if (!fresh) await runCommand('docker', ['cp', `${napcatContainer}:${containerPath}`, target], 8000)
    if (existsSync(target)) {
      const stat = statSync(target)
      return { ok: true, file: target, source: `容器 ${napcatContainer}:${containerPath}`, ageSeconds: Math.round((Date.now() - stat.mtimeMs) / 1000), bytes: stat.size }
    }
  } catch { /* 没有 docker / 没有那个容器：走下面的统一失败说明 */ }

  return {
    ok: false,
    reason: `没找到二维码。找过：${tried.join('、')}。宿主模式请把 NapCat 的 qrcode.png 路径填进控制台配置（napcatQr），或设环境变量 QQ_NAPCAT_QR`,
    tried,
  }
}

async function collectDocker() {
  const { ok, stdout } = await run('docker', ['ps', '-a', '--format', '{{.Names}}|{{.Image}}|{{.Status}}'], 8000)
  if (!ok) return { ok: false, containers: [] }
  const containers = stdout.split('\n').filter(Boolean).map((line) => {
    const [name, image, status] = line.split('|')
    return { name, image, status, healthy: /healthy/.test(status ?? ''), running: /^Up/.test(status ?? '') }
  })
  return { ok: true, containers }
}

function collectSystem() {
  const disk = (() => {
    try {
      const s = statfsSync(DATA_ROOT)
      const total = s.blocks * s.bsize
      const free = s.bfree * s.bsize
      return { totalBytes: total, freeBytes: free, usedPercent: total > 0 ? Math.round((1 - free / total) * 100) : null }
    } catch { return null }
  })()
  const mem = (() => {
    try {
      const info = readFileSync('/proc/meminfo', 'utf8')
      const pick = (key) => Number((new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(info) ?? [])[1] ?? 0) * 1024
      const total = pick('MemTotal'); const available = pick('MemAvailable')
      return { totalBytes: total, availableBytes: available, usedPercent: total > 0 ? Math.round((1 - available / total) * 100) : null }
    } catch { return null }
  })()
  const load = (() => { try { return readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).map(Number) } catch { return null } })()
  const up = (() => { try { return Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) } catch { return null } })()
  return { load, memory: mem, disk, uptimeSeconds: up }
}

async function collectVersions() {
  const { ok, stdout } = await run('docker', ['inspect', statusDefaults().napcatContainer, '--format', '{{.Config.Image}}'], 6000)
  let bridge = ''
  try { bridge = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version } catch { /* 忽略 */ }
  const dsh = dshVersion()
  return { node: process.version, dsh, bridge, napcatImage: ok ? stdout.trim() : '' }
}

/**
 * 按候选顺序探活宿主端口：第一个真的响应的（HTTP 200/401）就用它。
 * 全都无响应时退一步用"端口通但没响应"的那个，再退回第一个候选 ——
 * 这样页面至少能说清"我在探哪个端口、这个端口是从哪来的"，
 * 而不是替用户记死一个 3080 然后干说一句不可用。
 */
export async function resolveDshEndpoint(opts) {
  const candidates = Array.isArray(opts.dshPortCandidates) && opts.dshPortCandidates.length > 0
    ? opts.dshPortCandidates
    : [{ port: opts.dshPort, source: opts.dshPortSource || '默认值' }]
  const host = opts.dshHost
  const tried = []
  let firstOpen = null
  for (const cand of candidates.slice(0, 5)) {
    tried.push(cand.port)
    const probe = await httpProbe({ url: `http://${host}:${cand.port}/`, expect: (c) => c === 200 || c === 401 })
    if (probe.ok) return { port: cand.port, source: cand.source, open: true, usable: true, probe, tried }
    if (!firstOpen && await tcpProbe(cand.port, { host })) {
      firstOpen = { port: cand.port, source: cand.source, open: true, usable: false, probe, tried }
    }
  }
  return firstOpen ?? {
    port: candidates[0].port,
    source: candidates[0].source,
    open: false,
    usable: false,
    probe: { ok: false, code: 0, ms: 0 },
    tried,
  }
}

/** 汇总状态：系统 / 容器 / 桥接 / 代理 / 事故 / 版本。任何一项失败都不影响其它项。 */
export async function collectStatus(overrides = {}) {
  const opts = statusDefaults(overrides)
  const { dataRoot } = opts
  const runtime = readJsonSafe(join(dataRoot, 'state', 'runtime.json'))
  // 代理状态：以"宿主进程实际的环境变量"为准，状态文件里的探活记录只作为细节（并标明新旧）
  const proxy = describeProxy(dataRoot)
  const watchdogLog = tailLines(join(dataRoot, 'logs', 'dsh-watchdog.log'), 400)
    .filter((line) => line.includes('proxy check'))
    .slice(-5)
  const [napcatWebui, bridgePort, docker, versions] = await Promise.all([
    tcpProbe(opts.napcatWebuiPort, { host: opts.napcatHost }),
    tcpProbe(opts.bridgePort, { host: opts.bridgeHost }),
    collectDocker(),
    collectVersions(),
  ])
  const qrFile = join(dataRoot, 'state', 'napcat-qrcode.png')
  const dshEndpoint = await resolveDshEndpoint(opts)
  const qr = existsSync(qrFile)
    ? { cached: true, ageSeconds: Math.round((Date.now() - statSync(qrFile).mtimeMs) / 1000), bytes: statSync(qrFile).size }
    : { cached: false }
  return {
    ok: true,
    at: Date.now(),
    // [本地补丁] 会话所有权（SPEC §3 L1）：谁在托管、名册、容器是否在待机 / 状态机
    ownership: readOwnership(dataRoot),
    // [本地补丁] 模型凭据（SPEC §3 L4，D5：只检测与引导，不写盘）
    modelCredentials: detectModelCredentials({ dataRoot, dshHome: process.env.DSH_HOME || '', env: process.env }),
    system: { ...collectSystem(), ...versions },
    docker,
    ports: {
      dsh: dshEndpoint.port,
      // 这个端口是从哪来的（环境变量 / 运行中的进程 / 日志 / 默认值…），排查时最有用的一条
      dshSource: dshEndpoint.source,
      dshCandidates: (opts.dshPortCandidates ?? []).map((c) => ({ port: c.port, source: c.source })),
      dshProbed: dshEndpoint.tried,
      bridge: opts.bridgePort,
      napcatWebui: opts.napcatWebuiPort,
      // 三级证据：进程（由 runtime.json 的 pid + 存活判断）→ 端口 → 真实可用（发一次请求）
      dshProcess: Boolean(runtime?.pid),
      dshPortOpen: dshEndpoint.open,
      dshUsable: dshEndpoint.usable,
      dshProbe: dshEndpoint.probe,
      bridgePortOpen: bridgePort,
      bridgeUsable: bridgePort && runtime !== null,
      napcatWebuiPortOpen: napcatWebui,
      napcatUsable: (await httpProbe({ url: `http://${opts.napcatHost}:${opts.napcatWebuiPort}/`, expect: (c) => c >= 200 && c < 400 })).ok,
      napcatProbe: await httpProbe({ url: `http://${opts.napcatHost}:${opts.napcatWebuiPort}/`, expect: (c) => c >= 200 && c < 400 }),
    },
    bridge: runtime === null ? { available: false } : {
      available: true,
      pid: runtime.pid,
      version: runtime.version,
      uptimeSeconds: runtime.uptimeSeconds,
      sessionCount: runtime.sessionCount,
      sessions: Array.isArray(runtime.sessions) ? runtime.sessions.slice(0, 10) : [],
      botOnline: runtime.botOnline ?? null,
      botOnlineAt: runtime.botOnlineAt ?? 0,
      joinsPending: runtime.joinsPending ?? 0,
      reminders: runtime.reminders ?? 0,
      votes: runtime.votes ?? 0,
      games: runtime.games ?? 0,
      gateDenied: runtime.gate?.denied ?? 0,
      features: runtime.features ?? {},
      recentTraces: Array.isArray(runtime.recentTraces) ? runtime.recentTraces.slice(0, 8) : [],
    },
    proxy: proxy === null ? { available: false } : { available: true, ...proxy, log: watchdogLog },
    incidents: tailJsonl(join(dataRoot, 'logs', 'dsh-watchdog-incidents.jsonl'), 5),
    inbox: { file: join(dataRoot, 'logs', 'inbox.jsonl'), ...(runtime?.inbox ?? {}) },
    napcat: { container: opts.napcatContainer, webuiUp: napcatWebui, qr },
    webuiUrl: napcatWebUiUrl(opts),
    restartScript: opts.restartScript,
  }
}
