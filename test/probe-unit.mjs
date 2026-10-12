/**
 * [本地补丁] P3 外部探测（SPEC-ownership-and-takeover §3 L2）验收测试。
 *
 * 解析函数全是纯函数，用真机抓到的输出格式做 fixture（ss / lsof / PowerShell JSON / ps / CIM），
 * 探测函数注入假 exec 与假 http，覆盖：找到宿主 DSH、忽略自己管的端口与进程、工具缺失时 available=false、
 * 指纹不匹配的不算、会话锁旁证。
 */
import {
  isDshAuthBody, parseCimDshProcesses, parseLsofListeners, parsePsDshProcesses,
  parseSsListeners, parseWindowsListeners, probeForeignHarnesses, probeHeldSessionLocks, DSH_AUTH_MARKER,
} from '../control/lib/probe.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---- fixture（照真机格式抄的）----
const SS = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
  'LISTEN 0      511          127.0.0.1:3080       0.0.0.0:*',
  'LISTEN 0      511          127.0.0.1:3081       0.0.0.0:*    users:(("MainThread",pid=65,fd=18))',
  'LISTEN 0      511          127.0.0.1:6700       0.0.0.0:*    users:(("MainThread",pid=65,fd=19))',
  'LISTEN 0      511          127.0.0.1:6099       0.0.0.0:*',
].join('\n')
const LSOF = [
  'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
  'node       65 node   18u  IPv4  12345      0t0  TCP 127.0.0.1:3081 (LISTEN)',
  'node      900 node   19u  IPv4  12346      0t0  TCP 127.0.0.1:3080 (LISTEN)',
].join('\n')
const WIN_JSON = JSON.stringify([{ LocalPort: 3080, OwningProcess: 1234 }, { LocalPort: 6099, OwningProcess: 4321 }])
const PS = [
  '    1 /usr/bin/tini -- /app/entrypoint.sh',
  '   65 node /usr/local/bin/dsh web --no-open --port 3081',
  '  900 node /usr/local/bin/dsh web --no-open --port 3080',
  '  901 node /app/bridge/control/bin/qq-harness-supervisor.mjs --kind container',
  '  902 nginx: worker process',
].join('\n')
const CIM_JSON = JSON.stringify([
  { ProcessId: 1234, CommandLine: '"C:\\Users\\u\\AppData\\Local\\Programs\\DSH Desktop\\DeepSeek Harness.exe"' },
  { ProcessId: 99, CommandLine: 'node C:\\npm\\dsh web --no-open --port 3082' },
  { ProcessId: 77, CommandLine: 'node C:\\app\\qq-harness-supervisor.mjs --kind container' },
])
const AUTH_BODY = `${DSH_AUTH_MARKER}; reopen the URL printed by dsh web.`

// ---- 解析 ----
const ss = parseSsListeners(SS)
check('ss：解析出全部监听端口', ss.length === 4, JSON.stringify(ss.map((x) => x.port)))
check('ss：没有 owner 信息的标 owned=false（= 别的命名空间）', ss[0].owned === false && ss[1].owned === true && ss[1].pid === 65, JSON.stringify(ss[0]))
const lsof = parseLsofListeners(LSOF)
check('lsof：解析 pid 与端口', lsof.length === 2 && lsof[0].port === 3081 && lsof[1].pid === 900, JSON.stringify(lsof))
check('Windows JSON：解析 LocalPort/OwningProcess', parseWindowsListeners(WIN_JSON).length === 2 && parseWindowsListeners(WIN_JSON)[0].pid === 1234)
check('Windows JSON：坏输入返回空数组', parseWindowsListeners('not json').length === 0)

const ps = parsePsDshProcesses(PS, { selfPid: 1 })
check('ps：只挑 dsh，排除 supervisor/tini/nginx，并认领 --port', ps.length === 2 && ps.every((x) => x.command.includes('dsh web')) && ps[0].port === 3081 && ps[1].port === 3080,
  JSON.stringify(ps.map((x) => [x.pid, x.port])))
check('ps：排除自己管的那个端口（--port 3081）', parsePsDshProcesses(PS, { excludePort: 3081 }).length === 1,
  JSON.stringify(parsePsDshProcesses(PS, { excludePort: 3081 }).map((x) => x.pid)))
check('ps：排除自己的子进程 pid', parsePsDshProcesses(PS, { excludePids: [900] }).every((x) => x.pid !== 900))
const cim = parseCimDshProcesses(CIM_JSON)
check('CIM：认得桌面端与 node 跑的 dsh，排除 supervisor',
  cim.length === 2 && cim.some((x) => x.command.includes('DeepSeek Harness.exe')), JSON.stringify(cim.map((x) => x.pid)))

check('指纹：真机那句 401 body 命中', isDshAuthBody(AUTH_BODY) === true)
check('指纹：普通 401 / HTML 页不命中', isDshAuthBody('Unauthorized') === false && isDshAuthBody('<html>nope</html>') === false)

// ---- 探测：注入假 exec / 假 http ----
const fakeExec = (table) => async (cmd, args) => {
  const key = `${cmd} ${(args ?? []).join(' ')}`.trim()
  for (const [pattern, value] of table) if (key.startsWith(pattern)) return { ok: true, stdout: value, error: '' }
  return { ok: false, stdout: '', error: `ENOENT ${cmd}` }
}
const fakeHttp = (map) => async (port) => (map[port] !== undefined ? { ok: true, status: 401, body: map[port] } : { ok: false, status: 0, body: '' })

{
  const exec = fakeExec([['ss -ltnp', SS], ['ps -Ao pid=,command=', PS]])
  const httpProbe = fakeHttp({ 3080: AUTH_BODY, 6099: '<html>NapCat</html>' })
  const r = await probeForeignHarnesses({ env: { DSH_PORT: '3081' }, platform: 'linux', exec, httpProbe, sessionsDir: '/nope', ownPids: [65] })
  check('linux：找到宿主 3080（进程 + 端口两条证据合并成一条，带 pid 的胜出）',
    r.foreign.length === 1 && r.foreign[0].port === 3080,
    JSON.stringify(r.foreign))
  check('linux：available=true 且统计齐（listeners/processes/fingerprinted）',
    r.available === true && r.checked.listeners === 4 && r.checked.fingerprinted >= 1, JSON.stringify(r.checked))
  check('linux：自己管的端口（3081）不会被当成外人', r.foreign.every((x) => x.port !== 3081))
}
{
  const exec = fakeExec([['ss -ltnp', SS], ['ps -Ao pid=,command=', PS]])
  const httpProbe = fakeHttp({})   // 所有端口都不可达
  const r = await probeForeignHarnesses({ env: { DSH_PORT: '3081' }, platform: 'linux', exec, httpProbe, sessionsDir: '/nope', ownPids: [65] })
  check('linux：指纹都不通时仍靠进程证据认出宿主的 dsh（不误报成"没有"）', r.foreign.length === 1 && r.foreign[0].pid === 900, JSON.stringify(r.foreign))
}
{
  const exec = async () => ({ ok: false, stdout: '', error: 'command not found' })
  const r = await probeForeignHarnesses({ env: {}, platform: 'linux', exec, httpProbe: fakeHttp({}), sessionsDir: '/nope' })
  check('工具缺失：available=false，reason 说清为什么', r.available === false && r.reason.includes('不可用'), r.reason)
}
{
  const exec = fakeExec([['powershell -NoProfile -Command Get-NetTCPConnection', '[]'], ['powershell -NoProfile -Command Get-CimInstance', CIM_JSON]])
  const r = await probeForeignHarnesses({ env: {}, platform: 'win32', exec, httpProbe: fakeHttp({}), sessionsDir: '' })
  check('windows：CIM 里的 dsh/桌面端被识别为外部 harness', r.foreign.length === 2 && r.foreign.every((x) => x.kind === 'host'), JSON.stringify(r.foreign.map((x) => x.pid)))
}
{
  const files = ['/s/proj/a/session.lock', '/s/proj/b/session.lock', '/s/proj/c/session.lock']
  const exec = async (cmd, args) => {
    // 只有 /s/b 那把锁被持有 → flock 失败
    const lock = args[1]
    return lock === '/s/proj/b/session.lock' ? { ok: false, stdout: '', error: 'flock: failed' } : { ok: true, stdout: '', error: '' }
  }
  const exists = (p) => files.includes(p) || p === '/s'
  const readdir = (p) => (p === '/s' ? ['proj'] : (p === '/s/proj' ? ['a', 'b', 'c'] : []))
  const r = await probeHeldSessionLocks('/s', { exec, exists, readdir })
  check('会话锁旁证：锁不上 = 有人持有（1/3）', r.available === true && r.held === 1 && r.checked === 3, JSON.stringify(r))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
