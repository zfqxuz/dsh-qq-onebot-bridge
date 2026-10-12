/**
 * [本地补丁] 外部探测：找出"非参与者"的 harness（SPEC-ownership-and-takeover §3 L2）。
 *
 * 名册（心跳）只能看见装了新版插件/启动器的实例；用户手动起的 dsh、桌面端、或者在别的
 * 命名空间里跑的进程，只能靠平台手段去找。这层的价值是**正证据**：
 *   · 找到 → 一定有别的 harness（哪怕名册是空的）；
 *   · 找不到 ≠ 没有（探测盲区：WSL、没开 host 网络的 Docker Desktop、无端口桌面端…），
 *     所以调用方只在"名册空 + 探测也找不到"时接管，探测不可用时按 strict 策略处理。
 *
 * 手段（按平台）：
 *   linux   ss -ltnp（无 owner 信息 = 别的命名空间）+ ps//proc 进程名 + flock 试锁
 *   darwin  lsof -nP -iTCP -sTCP:LISTEN + ps
 *   win32   Get-NetTCPConnection + Get-CimInstance Win32_Process（CommandLine 里有 dsh）
 * 所有解析函数都是纯函数（见 test/probe-unit.mjs 的 fixture），探测只是把命令输出喂进去。
 */
import { execFile } from 'node:child_process'
import { get as httpGet } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH WebUI 的指纹：匿名访问回 401 + 这句话（真机实测）。 */
export const DSH_AUTH_MARKER = 'dsh web authentication required'

/** 默认不去探的端口（本机常见服务；探了也白探）。 */
export const DEFAULT_SKIP_PORTS = new Set([22, 80, 443, 3306, 5432, 5433, 6379, 6700, 5678, 6099, 8798, 8799, 9880])

export function isDshAuthBody(text) {
  return String(text ?? '').includes(DSH_AUTH_MARKER)
}

/** `ss -ltnp` 一行 → { port, pid, process, owned }（owned=false 表示看不到属主 = 别的命名空间）。 */
export function parseSsListeners(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim().startsWith('LISTEN') !== true) continue
    const portMatch = line.match(/(?:^|\s)(?:[\d.*[\]:]+):(\d+)\s/)
    if (portMatch === null) continue
    const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/)
    out.push({
      port: Number(portMatch[1]),
      pid: owner === null ? 0 : Number(owner[2]),
      process: owner === null ? '' : owner[1],
      owned: owner !== null,
    })
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN` → 同上（macOS/Linux 都可用）。 */
export function parseLsofListeners(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^(\S+)\s+(\d+)\s+.*TCP\s+\S*:(\d+)\s+\(LISTEN\)/)
    if (match === null) continue
    out.push({ port: Number(match[3]), pid: Number(match[2]), process: match[1], owned: true })
  }
  return out
}

/** Windows：`Get-NetTCPConnection -State Listen | ConvertTo-Json` → { port, pid, owned:true }。 */
export function parseWindowsListeners(jsonText) {
  let data = null
  try { data = JSON.parse(String(jsonText ?? '')) } catch { return [] }
  const list = Array.isArray(data) ? data : (data === null ? [] : [data])
  return list
    .map((item) => ({
      port: Number(item?.LocalPort) || 0,
      pid: Number(item?.OwningProcess) || 0,
      process: '',
      owned: Number(item?.OwningProcess) > 0,
    }))
    .filter((item) => item.port > 0)
}

/** `ps -Ao pid=,command=` → 命令行里带 dsh 的进程（排除本进程与探测命令自身）。 */
const PORT_IN_COMMAND = /--port[= ]([0-9]+)/

export function parsePsDshProcesses(text, { selfPid = process.pid, excludePids = [], excludePort = 0 } = {}) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2].trim()
    if (pid === selfPid) continue
    if (Array.isArray(excludePids) && excludePids.includes(pid)) continue
    if (/\b(?:dsh|deepseek-harness)\b/.test(command) !== true) continue
    if (/qq-harness-(?:owner|supervisor)|dsh-web-run|probe\.mjs/.test(command)) continue
    // 自己管的那个 dsh（supervisor 的子进程）不是"非参与者"
    const portMatch = command.match(PORT_IN_COMMAND)
    const port = portMatch === null ? 0 : Number(portMatch[1])
    if (Number(excludePort) > 0 && port === Number(excludePort)) continue
    out.push({ pid, command, port })
  }
  return out
}

/** Windows：`Get-CimInstance Win32_Process | ConvertTo-Json`（只看命令行里有 dsh 的）。 */
export function parseCimDshProcesses(jsonText, { selfPid = process.pid, excludePids = [], excludePort = 0 } = {}) {
  let data = null
  try { data = JSON.parse(String(jsonText ?? '')) } catch { return [] }
  const list = Array.isArray(data) ? data : (data === null ? [] : [data])
  const out = []
  for (const item of list) {
    const pid = Number(item?.ProcessId) || 0
    const command = String(item?.CommandLine ?? '')
    if (pid === 0 || pid === selfPid) continue
    if (Array.isArray(excludePids) && excludePids.includes(pid)) continue
    if (/\b(?:dsh|DeepSeek Harness)\b/i.test(command) !== true) continue
    if (/qq-harness-(?:owner|supervisor)|dsh-web-run/.test(command)) continue
    const portMatch = command.match(PORT_IN_COMMAND)
    const port = portMatch === null ? 0 : Number(portMatch[1])
    if (Number(excludePort) > 0 && port === Number(excludePort)) continue
    out.push({ pid, command, port })
  }
  return out
}

/** 默认执行器：跑一条命令，失败也返回 ok:false（探测绝不该抛）。 */
export function makeExec({ exec = execFile, timeout = 4000 } = {}) {
  return (command, args) => new Promise((resolve) => {
    try {
      exec(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? ''), error: error === null ? '' : String(error.message ?? error) })
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', error: String(error?.message ?? error) })
    }
  })
}

/** 匿名 GET 一个端口，拿 body（用于指纹）。超时=不可达。 */
export function makeHttpProbe({ get = httpGet, timeout = 500 } = {}) {
  return (port, host = '127.0.0.1') => new Promise((resolve) => {
    let done = false
    const finish = (value) => { if (done !== true) { done = true; resolve(value) } }
    try {
      const req = get({ host, port, path: '/', timeout }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { if (body.length < 4096) body += chunk })
        res.on('end', () => finish({ ok: true, status: res.statusCode ?? 0, body }))
      })
      req.on('timeout', () => { req.destroy(); finish({ ok: false, status: 0, body: '' }) })
      req.on('error', () => finish({ ok: false, status: 0, body: '' }))
    } catch { finish({ ok: false, status: 0, body: '' }) }
  })
}

/**
 * 找"非参与者"的 harness。
 * @returns {Promise<{ available:boolean, foreign:object[], reason:string, checked:object }>}
 */
export async function probeForeignHarnesses({
  env = process.env, platform = process.platform, exec = makeExec(), httpProbe = makeHttpProbe(),
  skipPorts = DEFAULT_SKIP_PORTS, maxProbes = 24, dshPorts = [],
  exists = existsSync, readdir = readdirSync, dataRoot = '', sessionsDir = '',
  ownPids = [], ownPort = Number(env.DSH_PORT) || 0,
} = {}) {
  const foreign = []
  const checked = { listeners: 0, processes: 0, locksHeld: 0, fingerprinted: 0, skipped: 0 }
  const reasons = []
  const own = new Set([...dshPorts.map(Number), Number(env.DSH_PORT) || 0, Number(env.QQ_DSH_PORT) || 0].filter((n) => n > 0))
  let available = false

  // 1) 监听端口（平台各自的手段）
  let listeners = []
  if (platform === 'win32') {
    const res = await exec('powershell', ['-NoProfile', '-Command', 'Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress'])
    if (res.ok) { listeners = parseWindowsListeners(res.stdout); available = true } else reasons.push(`Get-NetTCPConnection 不可用：${res.error}`)
  } else if (platform === 'darwin') {
    const res = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
    if (res.ok) { listeners = parseLsofListeners(res.stdout); available = true } else reasons.push(`lsof 不可用：${res.error}`)
  } else {
    const res = await exec('ss', ['-ltnp'])
    if (res.ok) { listeners = parseSsListeners(res.stdout); available = true } else reasons.push(`ss 不可用：${res.error}`)
  }
  checked.listeners = listeners.length

  // 2) 进程扫描（宿主侧最有力；容器里只能看到自己人）
  let processes = []
  if (platform === 'win32') {
    const res = await exec('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'])
    if (res.ok) processes = parseCimDshProcesses(res.stdout, { excludePids: ownPids, excludePort: ownPort })
  } else {
    const res = await exec('ps', ['-Ao', 'pid=,command='])
    if (res.ok) { processes = parsePsDshProcesses(res.stdout, { excludePids: ownPids, excludePort: ownPort }); available = true }
  }
  checked.processes = processes.length
  for (const item of processes) {
    foreign.push({ kind: platform === 'darwin' ? 'desktop' : 'host', pid: item.pid, port: item.port ?? 0, command: item.command, source: 'process' })
  }

  // 3) 端口指纹：只探"看起来不是我们"的端口，最多 maxProbes 个
  const candidates = listeners
    .filter((item) => item.port > 1023 && skipPorts.has(item.port) !== true && own.has(item.port) !== true)
    .slice(0, maxProbes)
  checked.skipped = Math.max(0, listeners.length - candidates.length)
  const results = await Promise.all(candidates.map(async (item) => ({ item, body: await httpProbe(item.port) })))
  for (const { item, body } of results) {
    checked.fingerprinted += 1
    if (body.ok !== true || isDshAuthBody(body.body) !== true) continue
    foreign.push({ kind: 'host', pid: item.pid, port: item.port, process: item.process, source: item.owned ? 'listener+pid' : 'listener-no-pid', command: `dsh web（端口 ${item.port}）` })
  }

  // 4) 会话锁（POSIX，旁证：有人正在写会话）
  const sessions = sessionsDir !== '' ? sessionsDir : join(String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'), 'sessions')
  if (platform !== 'win32') {
    const locks = await probeHeldSessionLocks(sessions, { exec })
    checked.locksHeld = locks.held
    if (locks.available === true) available = true
  }

  const dedup = new Map()
  for (const item of foreign) {
    // 同一个 harness 可能被"进程"和"端口"两条证据各抓到一次：按 kind+端口合并，优先留带 pid 的
    const key = Number(item.port) > 0 ? `${item.kind}:port:${item.port}` : `${item.kind}:pid:${item.pid}`
    const prev = dedup.get(key)
    if (prev === undefined || (Number(prev.pid) === 0 && Number(item.pid) > 0)) dedup.set(key, item)
  }
  const list = [...dedup.values()]
  const reason = list.length > 0
    ? `发现 ${list.length} 个非参与者 harness（${list.map((item) => item.command || item.kind).join(' / ')}）`
    : (available ? '没发现别的 harness（注意：探测有盲区，见 SPEC §5）' : `探测不可用：${reasons.join('；') || '本平台没有可用的手段'}；另外：${reasons.join('；')}`)
  return { available, foreign: list, reason, checked }
}

/**
 * 会话锁旁证：POSIX 上用 `flock -n` 试着锁一把已存在的 session.lock——锁不上说明有 writer。
 * 拿不到 PID 也能判断"有人在写"，所以它是名册之外第二好的正证据。
 */
export async function probeHeldSessionLocks(sessionsDir, { exec = makeExec(), limit = 60, exists = existsSync, readdir = readdirSync } = {}) {
  if (exists(sessionsDir) !== true) return { available: false, held: 0, checked: 0, reason: 'sessions 目录不存在' }
  let projects = []
  try { projects = readdir(sessionsDir).slice(0, 20) } catch { return { available: false, held: 0, checked: 0, reason: '列不出 sessions 目录' } }
  // DSH 布局：sessions/<projectKey>/<sessionId>/session.lock
  const files = []
  for (const project of projects) {
    const projectDir = join(sessionsDir, project)
    let sessions = []
    try { sessions = readdir(projectDir) } catch { continue }
    for (const session of sessions) {
      const lock = join(projectDir, session, 'session.lock')
      if (exists(lock)) files.push(lock)
      if (files.length >= limit) break
    }
    if (files.length >= limit) break
  }
  if (files.length === 0) return { available: false, held: 0, checked: 0, reason: '没有可试的 session.lock' }
  let held = 0
  for (const lock of files) {
    const res = await exec('flock', ['-n', lock, '-c', 'true'])
    if (res.ok !== true) held += 1
  }
  return { available: true, held, checked: files.length, reason: held > 0 ? `${held}/${files.length} 把会话锁被别人持有` : `${files.length} 把会话锁都空着` }
}
