/**
 * [本地补丁] P4 模型凭据检测与引导（SPEC-ownership-and-takeover §3 L4，D5：只引导不写盘）验收测试。
 *
 * 重点：① 三处来源都要看（.credentials.yaml 的 refs / 进程环境 / profile 的 provider-model）；
 *      ② **只回键名，绝不回值**（fixture 里放假 key，断言输出里搜不到）；
 *      ③ 没配时给出可执行引导；④ 坏文件不抛。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectModelCredentials, envKeyNames, parseCredentialRefs, profileModelHints } from '../control/lib/model-credentials.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-model-credentials-'))
// 短假值：够用来断言"结论里搜不到 key 值"，又不会撞上隐私套件的 `sk-…≥20 字符` 形态检查。
const FAKE_KEY = 'sk-fake-0001'

// 1) refs 解析：只取 refs 段下的键名，records 段不误取
const YAML = [
  'version: 1',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  `      secret: ${FAKE_KEY}`,
  'refs:',
  `  DEEPSEEK_API_KEY: ${FAKE_KEY}`,
  '  MY_OWN_VENDOR_KEY: another-secret',
  'other:',
  '  NOT_A_REF: x',
].join('\n')
const refs = parseCredentialRefs(YAML)
check('refs：只取 refs 段的键名', refs.length === 2 && refs.includes('DEEPSEEK_API_KEY') && refs.includes('MY_OWN_VENDOR_KEY'), JSON.stringify(refs))
check('refs：records 段与 refs 之外的键不会混进来', refs.includes('NOT_A_REF') === false && refs.includes('secret') === false, JSON.stringify(refs))
check('refs：坏文本不抛', parseCredentialRefs('refs:\n') .length === 0 && parseCredentialRefs(null).length === 0)

// 2) 环境变量：只回名字
const envKeys = envKeyNames({ DEEPSEEK_API_KEY: FAKE_KEY, PATH: '/usr/bin', EMPTY_KEY: '   ', MY_VENDOR_API_KEY: 'x' })
check('env：只挑 *_API_KEY 且有值', envKeys.includes('DEEPSEEK_API_KEY') && envKeys.includes('MY_VENDOR_API_KEY') && envKeys.includes('EMPTY_KEY') === false && envKeys.includes('PATH') === false, JSON.stringify(envKeys))

// 3) profile 提示
const dshHome = join(root, 'dsh')
mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), [
  '- id: agent-default-model',
  '  config:',
  '    provider: deepseek',
  '    model: deepseek-chat',
].join('\n'), 'utf8')
const hints = profileModelHints(dshHome)
check('profile：认出 provider/model', hints.length === 1 && hints[0].provider === 'deepseek' && hints[0].model === 'deepseek-chat', JSON.stringify(hints))

// 4) 三处来源组合
writeFileSync(join(dshHome, '.credentials.yaml'), YAML, 'utf8')
const all = detectModelCredentials({ dshHome, env: { OPENAI_API_KEY: FAKE_KEY } })
check('configured=true，三个来源都列出来', all.configured === true && all.sources.length === 3, JSON.stringify(all.sources.map((s) => s.kind)))
check('来源里带上了文件路径与 key 名（便于排查）', all.sources.some((s) => s.detail.includes('.credentials.yaml') && s.detail.includes('DEEPSEEK_API_KEY')), JSON.stringify(all.sources))
check('绝不泄漏 key 值（整个结论里搜不到 fixture 的 key）', JSON.stringify(all).includes(FAKE_KEY) === false, 'ok（只有键名）')

// 5) 没配 → 给引导
const none = detectModelCredentials({ dshHome: join(root, 'empty-dsh'), env: { PATH: '/usr/bin' } })
check('未配置：configured=false 且引导指向「设置 → 模型」', none.configured === false && none.guide.includes('设置 → 模型'), none.guide.slice(0, 50))

// 6) 只有环境变量也算配上
const envOnly = detectModelCredentials({ dshHome: join(root, 'empty-dsh'), env: { DEEPSEEK_API_KEY: FAKE_KEY } })
check('只看环境变量也能判定为已配置', envOnly.configured === true && envOnly.sources[0].kind === 'env', JSON.stringify(envOnly.sources))

// 7) 坏 credentials 文件不抛
mkdirSync(join(root, 'bad-dsh'), { recursive: true })
writeFileSync(join(root, 'bad-dsh', '.credentials.yaml'), 'refs:\n  A: \x00\x01broken', 'utf8')
const bad = detectModelCredentials({ dshHome: join(root, 'bad-dsh'), env: {} })
check('坏文件不抛（照常给出结论）', typeof bad.configured === 'boolean', JSON.stringify(bad.refs))

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
