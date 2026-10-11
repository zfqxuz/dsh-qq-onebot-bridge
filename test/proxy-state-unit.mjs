/**
 * 「宿主现在走代理还是直连」的测试（[本地补丁] 2026-10-12）
 *
 * 这块的坑是"读了别人写的状态文件当现状"：容器停机那一刻写进去的 direct 会一直显示到
 * 下一个人写它为止，页面于是长期显示错的模式。测试锁住：
 *   1. 有正在跑的宿主进程时，模式**只认进程环境**（ground truth），并带上 pid；
 *   2. 进程环境里没有代理变量 = 结论是"直连"，不是"不知道"；
 *   3. 状态文件和运行事实打架时必须标 stale，别拿旧值糊过去；
 *   4. 读不到进程时才回落状态文件，并说明来源是状态文件。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeProxy, detectHostProxy, readProxyState } from '../control/lib/proxy-state.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const nul = (...args) => args.join('\0')

const tmp = mkdtempSync(join(tmpdir(), 'proxy-state-'))
const procRoot = join(tmp, 'proc')
const dataRoot = join(tmp, 'qqbot')
mkdirSync(join(dataRoot, 'state'), { recursive: true })

function fakeHost(pid, env) {
  const dir = join(procRoot, String(pid))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cmdline'), nul('/home/zfq/node24/bin/node', '/home/zfq/node24/bin/dsh', 'web', '--no-open', '--port', '3081'), 'utf8')
  writeFileSync(join(dir, 'environ'), env.join('\0') + '\0', 'utf8')
  writeFileSync(join(dir, 'stat'), `${pid} (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${pid}\n`, 'utf8')
}
function fakeHostNoPort(pid, env, root = procRoot) {
  const dir = join(root, String(pid))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cmdline'), nul('/home/zfq/node24/bin/node', '/home/zfq/node24/bin/dsh', 'web', '--no-open'), 'utf8')
  writeFileSync(join(dir, 'environ'), env.join('\0') + '\0', 'utf8')
}

function writeState(obj) {
  writeFileSync(join(dataRoot, 'state', 'proxy.json'), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')
}

// ===== 1. 进程环境是唯一可信来源 =====
fakeHost(4444, ['PATH=/usr/bin', 'HTTPS_PROXY=http://127.0.0.1:10808', 'NO_PROXY=127.0.0.1'])
const live = detectHostProxy({ procRoot })
check('有代理变量 → proxy', live.mode === 'proxy' && live.proxy === 'http://127.0.0.1:10808', JSON.stringify(live))
check('带上宿主 pid', live.pid === 4444)

const procRoot2 = join(tmp, 'proc-lower')
const dirTmp = join(procRoot2, '5555')
mkdirSync(dirTmp, { recursive: true })
writeFileSync(join(dirTmp, 'cmdline'), nul('node', '/home/zfq/node24/bin/dsh', 'web', '--port', '3081'), 'utf8')
writeFileSync(join(dirTmp, 'environ'), 'http_proxy=http://127.0.0.1:10809\0', 'utf8')
check('小写 http_proxy 也认', detectHostProxy({ procRoot: procRoot2 }).proxy === 'http://127.0.0.1:10809')

const procRoot3 = join(tmp, 'proc-direct')
mkdirSync(join(procRoot3, '6666'), { recursive: true })
writeFileSync(join(procRoot3, '6666', 'cmdline'), nul('node', '/home/zfq/node24/bin/dsh', 'web', '--port', '3081'), 'utf8')
writeFileSync(join(procRoot3, '6666', 'environ'), 'PATH=/usr/bin\0', 'utf8')
const liveDirect = detectHostProxy({ procRoot: procRoot3 })
check('宿主在跑但没代理变量 → 结论是 direct（不是 unknown）', liveDirect.mode === 'direct' && liveDirect.pid === 6666)

check('没有 dsh 进程 → unknown', detectHostProxy({ procRoot: join(tmp, 'nope') }).mode === 'unknown')

const procRoot4 = join(tmp, 'proc-noport')
fakeHostNoPort(7777, ['HTTPS_PROXY=http://127.0.0.1:10808'], procRoot4)
check('没写 --port 的宿主也能读到代理', detectHostProxy({ procRoot: procRoot4 })?.mode === 'proxy')

// ===== 2. 状态文件只是兜底 =====
writeState({ at: 1000, proxy: 'http://127.0.0.1:10808', code: '000', healthy: false, mode: 'direct', source: 'entrypoint' })
const merged = describeProxy(dataRoot, { procRoot })
check('进程说 proxy，就报 proxy', merged.mode === 'proxy', JSON.stringify({ mode: merged.mode, source: merged.modeSource }))
check('来源写明是宿主进程环境（带 pid）', merged.modeSource.includes('4444'))
check('状态文件与运行事实不一致 → stale', merged.stale === true)
check('探活记录单独带着（含 code/来源）', merged.probe?.code === '000' && merged.probe.source === 'entrypoint')
check('进程是 proxy 且最近探活不可用 → healthy=false', merged.healthy === false)
check('代理地址沿用进程里的值', merged.proxy === 'http://127.0.0.1:10808')

writeState({ at: 2000, proxy: 'http://127.0.0.1:10808', code: '401', healthy: true, mode: 'proxy', source: 'watchdog' })
const agree = describeProxy(dataRoot, { procRoot })
check('两边一致时 stale=false', agree.stale === false)
check('探活可用 → healthy=true', agree.healthy === true)

// 进程环境直连、状态文件说 proxy（反向打架）
const directMerged = describeProxy(dataRoot, { procRoot: procRoot3 })
check('反向打架也以进程为准（direct）', directMerged.mode === 'direct' && directMerged.stale === true)
check('直连时不因为旧的探活失败显示异常', directMerged.healthy === true)

// 没有进程 → 回落状态文件并说明
const fallback = describeProxy(dataRoot, { procRoot: join(tmp, 'nope') })
check('读不到进程时用状态文件的模式', fallback.mode === 'proxy')
check('并说明依据是状态文件', fallback.modeSource.includes('状态文件'), fallback.modeSource)

const none = describeProxy(dataRoot, { procRoot: join(tmp, 'nope'), readFile: () => { throw new Error('nope') } })
check('什么都没有 → unknown + 没有探活记录', none.mode === 'unknown' && none.probe === null)

check('坏 JSON → 状态记为 null', readProxyState(dataRoot, { readFile: () => '{ 坏' }) === null)
check('文件缺失 → null', readProxyState(join(tmp, '无此目录')) === null)

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} proxy-state-unit：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
