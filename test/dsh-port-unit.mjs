/**
 * DSH 宿主端口解析的测试（[本地补丁] 2026-10-12）
 *
 * 这块以前是控制台最硬的一根写死默认值（3080）。这个测试锁住三件事：
 *   1. 日志/地址文本里要取**最后一次**出现的端口（日志是追加的，第一条往往是旧的）；
 *   2. 候选顺序：显式 env → 控制台配置 → 正在跑的进程 → 登记地址 → 日志 → 默认值；
 *   3. 没有 env、没有配置文件、没有 /proc 时，必须老老实实回落到 3080 并标明"默认值"，
 *      不允许猜一个具体端口冒充"运行事实"。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_DSH_PORT, configuredHostPort, dshPortCandidates, lastUrlPort, parseDshCmdline, scanDshProcesses } from '../control/lib/dsh-port.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const nul = (...args) => args.join('\0')

// ===== 1. 文本里取最后一个端口 =====
check('日志取最后一次（旧 3080 在前、新 3081 在后）',
  lastUrlPort('dsh web: http://127.0.0.1:3080/?token=a\ndsh web: http://127.0.0.1:3081/?token=b') === 3081)
check('没有 URL → null', lastUrlPort('什么都没打印') === null)
check('空文本 → null', lastUrlPort('') === null && lastUrlPort(null) === null)
check('带 token 的地址也能取', lastUrlPort('http://127.0.0.1:3099/?token=xyz') === 3099)

// ===== 2. cmdline 解析 =====
check('NUL 分隔的 --port 3081',
  parseDshCmdline(nul('/home/zfq/node24/bin/node', '/usr/local/lib/node_modules/@deepseek-ai/dsh/bin.js', 'web', '--no-open', '--port', '3081'))?.port === 3081)
check('--port=3082', parseDshCmdline(nul('node', 'dsh', 'web', '--port=3082'))?.port === 3082)
check('-p 3083', parseDshCmdline(nul('node', 'dsh', 'web', '-p', '3083'))?.port === 3083)
check('没有 web 子命令 → null', parseDshCmdline(nul('node', 'something-else', '--port', '3081')) === null)
check('没有端口参数 → 认得是 dsh web，但端口为 null',
  parseDshCmdline(nul('node', 'dsh', 'web', '--no-open'))?.port === null)
check('空 cmdline → null', parseDshCmdline('') === null && parseDshCmdline('\0\0') === null)
check('非法端口不算数（不返回端口）', parseDshCmdline(nul('node', 'dsh', 'web', '--port', '70000'))?.port === null)
check('不是 dsh 的 web → null', parseDshCmdline(nul('node', '/opt/other/bin/web', 'web', '--port', '3081')) === null)

// ===== 3. 扫假 /proc =====
const tmp = mkdtempSync(join(tmpdir(), 'dsh-port-'))
const procRoot = join(tmp, 'proc')
function fakeProc(pid, port, started) {
  const dir = join(procRoot, String(pid))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cmdline'), nul('node', '/opt/dsh/bin.js', 'web', '--port', String(port)), 'utf8')
  // /proc/<pid>/stat 第 22 个字段（rest[19]）是启动时刻
  const rest = ['S', ...Array.from({ length: 18 }, () => '0'), String(started)]
  writeFileSync(join(dir, 'stat'), `${pid} (node) ${rest.join(' ')}\n`, 'utf8')
}
fakeProc(1111, 3080, 1000)
fakeProc(2222, 3084, 2000)
mkdirSync(join(procRoot, 'not-a-pid'), { recursive: true })
const scan = scanDshProcesses({ procRoot })
check('扫到两个 dsh 进程', scan.length === 2, JSON.stringify(scan))
check('新的排前面（pid 2222 的 3084）', scan[0]?.port === 3084 && scan[0]?.pid === 2222)
check('旧的在后面', scan[1]?.port === 3080 && scan[1]?.pid === 1111)
check('没有 /proc 时返回空数组（不影响其它来源）', scanDshProcesses({ procRoot: join(tmp, 'nope') }).length === 0)

// ===== 4. 候选顺序 =====
const dataRoot = join(tmp, 'qqbot')
mkdirSync(join(dataRoot, 'state'), { recursive: true })
mkdirSync(join(dataRoot, 'logs'), { recursive: true })
writeFileSync(join(dataRoot, 'state', 'dsh-web-url.txt'), 'http://127.0.0.1:3090/?token=abc\n', 'utf8')
writeFileSync(join(dataRoot, 'logs', 'dsh-web.log'), 'dsh web: http://127.0.0.1:3080/?token=old\ndsh web: http://127.0.0.1:3091/?token=new\n', 'utf8')
const configFile = join(tmp, 'qq-control.json')
writeFileSync(configFile, JSON.stringify({ ports: { host: 3092 } }), 'utf8')

const all = dshPortCandidates({ env: { QQ_DSH_PORT: '3093' }, dataRoot, configFile, procRoot })
// 注意：3080 同时被"进程(pid 1111)"和"默认值"占着，去重后保留更靠前的"进程"来源，
// 所以这条里 3080 出现一次、位置在进程那一段，末尾不会再补一个"默认值"。
check('优先级顺序（env → 配置 → 进程 → 登记 → 日志 → 默认）',
  all.map((c) => c.port).join(',') === '3093,3092,3084,3080,3090,3091',
  all.map((c) => `${c.port}(${c.source})`).join(' '))
check('每项都带可读的来源说明', all.every((c) => typeof c.source === 'string' && c.source.length > 0))
check('来源里点明了 pid', all.some((c) => c.port === 3084 && c.source.includes('2222')))
check('去重：3080 只出现一次', all.filter((c) => c.port === 3080).length === 1)

const noEnv = dshPortCandidates({ env: {}, dataRoot, configFile, procRoot })
check('没有 env 时用配置里的 3092', noEnv[0].port === 3092 && noEnv[0].source.includes('qq-control.json'))

const bare = dshPortCandidates({ env: {}, dataRoot: join(tmp, 'empty'), configFile: join(tmp, 'missing.json'), procRoot: join(tmp, 'nope') })
check('什么都没有 → 只有默认 3080，且标明来源是默认值',
  bare.length === 1 && bare[0].port === DEFAULT_DSH_PORT && bare[0].source.includes('默认值'), JSON.stringify(bare))

// ===== 5. 配置文件读取 =====
check('显式 ports.host 生效', configuredHostPort(configFile) === 3092)
writeFileSync(join(tmp, 'bad.json'), '{ 不是 json', 'utf8')
check('坏 JSON 不抛错 → null', configuredHostPort(join(tmp, 'bad.json')) === null)
check('文件不存在 → null', configuredHostPort(join(tmp, 'missing.json')) === null)
writeFileSync(join(tmp, 'noHost.json'), JSON.stringify({ ports: { onebot: 6700 } }), 'utf8')
check('只配了别的端口 → null', configuredHostPort(join(tmp, 'noHost.json')) === null)

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} dsh-port-unit：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
