/**
 * 二维码来源的测试（2026-10-12）——锁住"没有 Docker 也能扫码"这件事
 *
 * 背景：控制台以前只会 `docker cp napcat:/app/napcat/cache/qrcode.png`，
 * 于是**完全没装 Docker 的机器**（NapCat 用官方原生安装器）页面上永远拿不到二维码，
 * 尽管二维码就躺在用户自己机器的某个目录里。
 *
 * 现在来源链是"宿主文件优先 → 容器 docker cp 兜底"，这个测试锁住：
 *   1. 配置里的 napcatQr、NapCat 启动脚本同级 cache、QQ_NAPCAT_QR、数据根 cache 四条宿主来源都能认出来；
 *   2. fetchQrImage 真的把宿主文件拷到 <数据根>/state/napcat-qrcode.png 并报出来源；
 *   3. 一个都找不到时，reason 要说清"找过哪些地方"（而不是干说一句失败）；
 *   4. 全程不依赖 docker（测试机没有 docker 也必须全绿）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fetchQrImage, hostQrCandidates } from '../control/lib/status-page.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const tmp = mkdtempSync(join(tmpdir(), 'qr-source-'))
const dataRoot = join(tmp, 'qqbot')
mkdirSync(join(dataRoot, 'state'), { recursive: true })
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') // PNG 头，够用了

// ---------- 1. 配置里显式写 napcatQr ----------
const viaConfig = join(tmp, 'custom-qr.png')
writeFileSync(viaConfig, PNG)
const configFile = join(tmp, 'qq-control.json')
writeFileSync(configFile, JSON.stringify({ napcatQr: viaConfig }), 'utf8')
const c1 = hostQrCandidates({ configFile, dataRoot, env: {} })
check('配置里的 napcatQr 被认出来', c1.includes(viaConfig), JSON.stringify(c1))

// ---------- 2. NapCat 启动脚本同级的 cache/qrcode.png（Windows 一键包布局）----------
const napcatDir = join(tmp, 'NapCat.31113.Shell')
mkdirSync(join(napcatDir, 'bootmain', 'cache'), { recursive: true })
writeFileSync(join(napcatDir, 'bootmain', 'napcat.bat'), '@echo off\n')
writeFileSync(join(napcatDir, 'bootmain', 'cache', 'qrcode.png'), PNG)
const configBat = join(tmp, 'bat.json')
writeFileSync(configBat, JSON.stringify({ napcatBat: join(napcatDir, 'bootmain', 'napcat.bat') }), 'utf8')
const c2 = hostQrCandidates({ configFile: configBat, dataRoot, env: {} })
check('由 napcatBat 推出同级 cache/qrcode.png',
  c2.includes(join(napcatDir, 'bootmain', 'cache', 'qrcode.png')), JSON.stringify(c2))

// ---------- 3. QQ_NAPCAT_QR 环境变量 ----------
const viaEnv = join(tmp, 'env-qr.png')
writeFileSync(viaEnv, PNG)
check('环境变量 QQ_NAPCAT_QR 被认出来',
  hostQrCandidates({ configFile: join(tmp, 'none.json'), dataRoot, env: { QQ_NAPCAT_QR: viaEnv } }).includes(viaEnv))

// ---------- 4. 数据根下的 napcat-cache/qrcode.png ----------
const viaDataRoot = join(dataRoot, 'napcat-cache', 'qrcode.png')
mkdirSync(join(dataRoot, 'napcat-cache'), { recursive: true })
writeFileSync(viaDataRoot, PNG)
check('数据根 napcat-cache/qrcode.png 被认出来',
  hostQrCandidates({ configFile: join(tmp, 'none.json'), dataRoot, env: {} }).includes(viaDataRoot))

// ---------- 5. 不存在的路径不算候选 ----------
check('不存在的路径不进候选',
  hostQrCandidates({ configFile: join(tmp, 'none.json'), dataRoot: join(tmp, 'empty'), env: { QQ_NAPCAT_QR: join(tmp, 'nope.png') } }).length === 0)

// ---------- 6. fetchQrImage：宿主文件优先，拷到 state/ 并报来源 ----------
const noDocker = async () => ({ ok: false, stdout: '' })
const r1 = await fetchQrImage({ dataRoot, configFile, env: { QQ_NAPCAT_QR: viaEnv }, runCommand: noDocker })
check('fetchQrImage 成功（宿主文件）', r1.ok === true, JSON.stringify(r1))
check('拷到了 <数据根>/state/napcat-qrcode.png',
  r1.ok && r1.file === join(dataRoot, 'state', 'napcat-qrcode.png') && existsSync(r1.file))
check('字节数对得上', r1.ok && r1.bytes === PNG.length, `bytes=${r1.bytes}`)
check('报出来源是宿主文件', r1.ok && String(r1.source).startsWith('宿主文件'), r1.source)
check('内容与源文件一致', r1.ok && readFileSync(r1.file).equals(PNG))

// ---------- 7. 一个都找不到：reason 要说清找过哪些地方 ----------
// 这台机器上可能真有 docker + napcat 容器，所以显式注入"没有 docker"的执行器，保证测试可复现
const r2 = await fetchQrImage({ dataRoot: join(tmp, 'empty-root'), configFile: join(tmp, 'none.json'), env: { QQ_NAPCAT_QR: join(tmp, 'nope.png') }, runCommand: noDocker })
check('找不到时 ok=false', r2.ok === false)
check('找不到时说明找过哪些地方', typeof r2.reason === 'string' && r2.reason.includes('找过') && r2.reason.includes('QQ_NAPCAT_QR'), r2.reason)
check('失败时也提到容器那条路（docker cp）', Array.isArray(r2.tried) && r2.tried.some((t) => t.startsWith('容器 ')), JSON.stringify(r2.tried))

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} qr-source-unit：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
