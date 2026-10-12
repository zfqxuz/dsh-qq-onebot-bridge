/**
 * [本地补丁] 模型凭据检测与引导（SPEC-ownership-and-takeover §3 L4，决策 D5：只引导、不代写）。
 *
 * DSH 的凭据分层（官方实现里的顺序，决定"用户到底配没配"）：
 *   进程环境变量（最高）> $DSH_HOME/.credentials.yaml（控制台/网页可写）> 调用目录 .env > $DSH_HOME/.env
 * 所以这里**只看名字、不取值**，三处都看一眼：
 *   · .credentials.yaml 的 `refs:` 键名（形如 DEEPSEEK_API_KEY）；
 *   · 进程环境里已知的 *_API_KEY（含自定义供应商的）；
 *   · profile 的补丁里有没有显式设 provider/model（有 ≠ 有 key，但能说明用户在配）。
 * 结论只有两种：配了（说清来源）/ 没配（给出可执行引导：去宿主「设置 → 模型」填）。
 * **绝不**读值、绝不写文件（D5），也不把结果混进诊断包。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 常见供应商的 key 名（只用于"有没有配"的判断，不校验值）。 */
export const KNOWN_KEY_REFS = [
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'ZHIPUAI_API_KEY', 'GLM_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY', 'SILICONFLOW_API_KEY',
  'OPENROUTER_API_KEY', 'AZURE_OPENAI_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY',
]

/** 从 .credentials.yaml 文本里取出 `refs:` 下的键名（不碰值）。 */
export function parseCredentialRefs(text) {
  const refs = []
  const lines = String(text ?? '').split('\n')
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs !== true) continue
    if (/^\S/.test(line)) break                    // 出了 refs 段
    const match = line.match(/^\s{2}([A-Za-z0-9_]+):/)
    if (match !== null) refs.push(match[1])
  }
  return [...new Set(refs)]
}

/** 环境里的 key 名（只回名字）。 */
export function envKeyNames(env = process.env, extraUnknown = true) {
  const names = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string' || value.trim() === '') continue
    if (/_API_KEY$/.test(key) || KNOWN_KEY_REFS.includes(key)) names.push(key)
    else if (extraUnknown === true && /^(?:DEEPSEEK|OPENAI|ANTHROPIC|GLM|ZHIPU|MOONSHOT)_/.test(key) && /KEY|TOKEN/.test(key)) names.push(key)
  }
  return [...new Set(names)].sort()
}

/** profile 补丁里有没有显式 provider/model（只看键名与粗值，不解析 YAML）。 */
export function profileModelHints(dshHome, { exists = existsSync, readdir = readdirSync, read = readFileSync } = {}) {
  const dir = join(String(dshHome), 'profiles')
  if (exists(dir) !== true) return []
  const out = []
  let profiles = []
  try { profiles = readdir(dir) } catch { return [] }
  for (const profile of profiles) {
    const file = join(dir, profile, 'cordis.patch.yml')
    if (exists(file) !== true) continue
    let text = ''
    try { text = read(file, 'utf8') } catch { continue }
    const provider = /^\s*provider:\s*(\S+)/m.exec(text)
    const model = /^\s*model:\s*(\S+)/m.exec(text)
    if (provider !== null || model !== null) {
      out.push({ profile, provider: provider === null ? '' : provider[1].replace(/['"]/g, ''), model: model === null ? '' : model[1].replace(/['"]/g, '') })
    }
  }
  return out
}

/**
 * 检测结论。
 * @returns {{ configured:boolean, sources:object[], refs:string[], envKeys:string[], profiles:object[],
 *             credentialsFile:string, guide:string }}
 */
export function detectModelCredentials({
  dataRoot = '', dshHome = '', env = process.env,
  exists = existsSync, read = readFileSync, readdir = readdirSync,
} = {}) {
  const home = String(dshHome ?? '').trim() || String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const credentialsFile = join(home, '.credentials.yaml')
  let refs = []
  if (exists(credentialsFile) === true) {
    try { refs = parseCredentialRefs(read(credentialsFile, 'utf8')) } catch { refs = [] }
  }
  const envKeys = envKeyNames(env)
  const profiles = profileModelHints(home, { exists, readdir, read })

  const sources = []
  if (refs.length > 0) sources.push({ kind: 'credentials-file', detail: `${credentialsFile}（${refs.join(', ')}）` })
  if (envKeys.length > 0) sources.push({ kind: 'env', detail: `环境变量 ${envKeys.join(', ')}` })
  if (profiles.length > 0) sources.push({ kind: 'profile', detail: profiles.map((p) => `${p.profile}${p.provider ? ` provider=${p.provider}` : ''}${p.model ? ` model=${p.model}` : ''}`).join('；') })
  const configured = sources.length > 0
  const guide = configured
    ? `已检测到模型凭据：${sources.map((s) => s.detail).join(' ｜ ')}。想换供应商/换 key，去宿主 DSH 的「设置 → 模型」。`
    : '没检测到模型凭据：打开宿主 DSH 的「设置 → 模型」填一个（DeepSeek 开放平台取 key，也支持自定义 baseUrl / 模型名），填完这里会自己变成"已配置"。'
  return { configured, sources, refs, envKeys, profiles, credentialsFile, guide }
}
