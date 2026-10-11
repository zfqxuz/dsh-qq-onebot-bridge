/**
 * 插件与密钥管理的数据层（[阶段 1] 2026-10-12）
 *
 * 用户需求：有些插件要配 token / sshkey，希望插件管理也能在控制台里做。
 *
 * 现状（实测，别依赖 `dsh plugin` CLI —— 它现在因 corepack pnpm 缓存缺失直接报错）：
 *   1. profile bundles：~/.dsh/profiles/<profile>/package.json 的 dsh.profile.bundles
 *   2. 本地插件目录：~/.dsh/plugins/<name>（通常是指向 /home/zfq/dev/dsh-plugins/<name> 的软链）
 *   3. home patch：~/.dsh/cordis.patch.yml —— 真正写配置的地方（id/name/config）
 *   4. 密钥：~/.dsh/.credentials.yaml（如 DEEPSEEK_API_KEY）、NapCat 的 webui.json token、
 *      以及插件 config 里的 sshKey（**是路径**，不是私钥内容）
 *
 * 安全原则：浏览器拿不到明文密钥。sshKey 只回路径+指纹；token 只回"是否已设置"；配置文本回脱敏副本。
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SECRET_KEY_RE = /(token|secret|password|passwd|apikey|api_key|sshkey|privatekey|private_key)/i

function run(command, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error?.code ?? 0 })
    })
  })
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 脱敏：只保留"值存在"，不留内容；sshKey 这种路径不算秘密，保留。 */
export function redactConfig(text) {
  return String(text ?? '').split('\n').map((line) => {
    const m = /^(\s*[\w.-]+:\s*)(.+)$/.exec(line)
    if (!m) return line
    const key = m[1].trim()
    if (!SECRET_KEY_RE.test(key)) return line
    if (/sshkey/i.test(key)) return line   // sshKey 是路径，保留可见（指纹另行展示）
    const value = m[2].trim()
    return `${m[1]}${value === '' ? '' : '<已设置，已隐藏>'}`
  }).join('\n')
}

/** 从 patch 文本里切出每个 `- id: <id>` 块（含后续 config），返回 { id, name, blockText, startLine, endLine }。 */
export function extractPluginBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let current = null
  for (let i = 0; i < lines.length; i++) {
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[i])
    if (idMatch) {
      if (current) { current.endLine = i - 1; blocks.push(current) }
      current = { id: idMatch[1], name: '', startLine: i, endLine: lines.length - 1, blockText: '' }
      continue
    }
    if (!current) continue
    const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(lines[i])
    if (nameMatch && current.name === '') current.name = nameMatch[1].replace(/^['"]|['"]$/g, '')
  }
  if (current) { current.endLine = lines.length - 1; blocks.push(current) }
  for (const b of blocks) b.blockText = lines.slice(b.startLine, b.endLine + 1).join('\n')
  return blocks
}

/** 盘点：profile bundles、本地插件目录、home patch 里的插件与配置（脱敏）、密钥存在性。 */
export async function listPlugins({ dshHome = '/home/zfq/.dsh', profile = 'web', pluginsRoot = '/home/zfq/dev/dsh-plugins' } = {}) {
  const profileDir = join(dshHome, 'profiles', profile)
  const profilePkg = readJsonSafe(join(profileDir, 'package.json')) ?? {}
  const dshNodeModules = '/home/zfq/node24/lib/node_modules/@deepseek-ai/dsh/node_modules'
  const bundles = (profilePkg?.dsh?.profile?.bundles ?? []).map((name) => {
    const inProfile = existsSync(join(profileDir, 'node_modules', name))
    const inDsh = existsSync(join(dshNodeModules, name))
    return { name, installed: inProfile || inDsh, source: inProfile ? 'profile' : (inDsh ? 'dsh 内置' : '缺失') }
  })

  const localDirs = []
  const pluginsDir = join(dshHome, 'plugins')
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir)) {
      if (entry.startsWith('.') || /\.bak/.test(entry)) continue
      const full = join(pluginsDir, entry)
      let stat = null
      try { stat = lstatSync(full) } catch { continue }
      const linkTarget = stat.isSymbolicLink() ? realpathSync(full) : ''
      const pkg = readJsonSafe(join(linkTarget || full, 'package.json')) ?? {}
      localDirs.push({
        id: entry,
        symlink: stat.isSymbolicLink(),
        target: linkTarget,
        broken: stat.isSymbolicLink() && !existsSync(full),
        version: pkg.version ?? '',
        description: typeof pkg.description === 'string' ? pkg.description.slice(0, 120) : '',
        sourceExists: existsSync(linkTarget || full),
      })
    }
  }

  const homePatchFile = join(dshHome, 'cordis.patch.yml')
  const homePatch = existsSync(homePatchFile) ? readFileSync(homePatchFile, 'utf8') : ''
  const homePlugins = extractPluginBlocks(homePatch).map((b) => ({
    id: b.id, name: b.name, file: homePatchFile,
    configKeys: [...b.blockText.matchAll(/^\s{4,}([\w.-]+):/gm)].map((m) => m[1]),
    redacted: redactConfig(b.blockText),
  }))

  const credentialsFile = join(dshHome, '.credentials.yaml')
  const credentialsText = existsSync(credentialsFile) ? readFileSync(credentialsFile, 'utf8') : ''
  const credentialKeys = [...credentialsText.matchAll(/^\s{2}([A-Z0-9_]+):/gm)].map((m) => m[1])

  const napcatWebui = readJsonSafe('/home/zfq/dshbot/qq/napcat-config/webui.json')
  const onebot = (() => {
    try {
      const dir = '/home/zfq/dshbot/qq/napcat-config'
      const f = readdirSync(dir).find((n) => /^onebot11_\d+\.json$/.test(n))
      if (!f) return null
      const cfg = readJsonSafe(join(dir, f))
      return { file: join(dir, f), hasToken: Boolean(cfg?.network?.websocketClients?.[0]?.token) }
    } catch { return null }
  })()

  return {
    ok: true,
    profile: { name: profile, dir: profileDir, file: join(profileDir, 'package.json'), bundles },
    localPluginDirs: localDirs,
    homePatch: { file: homePatchFile, exists: existsSync(homePatchFile), plugins: homePlugins },
    secrets: {
      credentialsFile, credentialKeys,
      napcatWebuiToken: Boolean(napcatWebui?.token),
      onebot,
    },
    pluginsRoot: { dir: pluginsRoot, exists: existsSync(pluginsRoot) },
  }
}

/** 白名单字段写入 home patch 的某个插件块：先备份、只改一行、改完回读校验。 */
export function updateHomePluginValue({ dshHome = '/home/zfq/.dsh', id, key, value }) {
  if (!id || !key) return { ok: false, error: '要提供 id 和 key' }
  const file = join(dshHome, 'cordis.patch.yml')
  if (!existsSync(file)) return { ok: false, error: `找不到 ${file}` }
  const text = readFileSync(file, 'utf8')
  const blocks = extractPluginBlocks(text)
  const block = blocks.find((b) => b.id === id)
  if (!block) return { ok: false, error: `patch 里没有插件 ${id}` }
  const lines = text.split('\n')
  const re = new RegExp(`^(\\s{4,})${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.*)$`)
  let hit = -1
  for (let i = block.startLine + 1; i <= block.endLine && i < lines.length; i++) {
    if (re.test(lines[i])) { hit = i; break }
  }
  const rendered = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : JSON.stringify(value)
  if (hit === -1) return { ok: false, error: `插件 ${id} 的配置里没有 ${key}（只能改已存在的键）` }
  const backup = `${file}.bak-console-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(file, backup)
  lines[hit] = lines[hit].replace(re, `$1${key}: ${rendered}`)
  writeFileSync(file, lines.join('\n'))
  const after = extractPluginBlocks(readFileSync(file, 'utf8')).find((b) => b.id === id)
  const okLine = after && new RegExp(`^\\s*${key}:`, 'm').test(after.blockText)
  return { ok: Boolean(okLine), file, backup, line: hit + 1, key, value: redactConfig(`${key}: ${rendered}`).split(': ')[1] }
}

/** ssh key 指纹（只读 ssh-keygen，不回私钥内容）。 */
export async function keyFingerprint(keyPath) {
  if (!keyPath || !existsSync(keyPath)) return { ok: false, error: 'key 文件不存在' }
  const r = await run('ssh-keygen', ['-lf', keyPath], 6000)
  return r.ok ? { ok: true, fingerprint: r.stdout.trim() } : { ok: false, error: r.stderr.trim() || 'ssh-keygen 失败' }
}

/** ssh 连通性测试：BatchMode 禁止交互，5 秒超时，回显远端 hostname 作为成功证据。 */
export async function sshTest({ host, user, port = 22, keyPath, timeoutSeconds = 5 }) {
  if (!host || !user) return { ok: false, error: '要提供 host 和 user' }
  const args = ['-i', keyPath || '/dev/null', '-p', String(port), '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeoutSeconds}`, '-o', 'StrictHostKeyChecking=accept-new', `${user}@${host}`, 'echo CONSOLE_SSH_OK; hostname']
  const r = await run('ssh', args, (timeoutSeconds + 4) * 1000)
  const out = `${r.stdout}${r.stderr}`.trim()
  return { ok: r.ok && r.stdout.includes('CONSOLE_SSH_OK'), output: out.slice(0, 800) }
}
