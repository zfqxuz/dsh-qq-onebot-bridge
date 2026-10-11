/**
 * 插件管理的数据层（阶段 1 重做版，2026-10-12）
 *
 * 用户要的是**插件维度**的管理：列表 → 装 / 删 / 启用 / 禁用 → 每个插件单独配置（弹窗）。
 * 所以这里对外只暴露插件对象与动作，不再把 patch 原文丢给前端。
 *
 * 事实依据（实测，别依赖 `dsh plugin` CLI —— 本机它因 corepack pnpm 缓存缺失直接报错）：
 *   1. profile bundles：~/.dsh/profiles/<profile>/package.json → dsh.profile.bundles
 *   2. 本地插件目录：~/.dsh/plugins/<name>（软链到 /home/zfq/dev/dsh-plugins/<name>）
 *   3. 真正生效的配置：~/.dsh/cordis.patch.yml 里每个 `- id: <id>` 块的 config
 *   4. 密钥：~/.dsh/.credentials.yaml、NapCat webui.json、插件 config 里的 sshKey（是路径）
 *
 * 安全：token/secret 类字段只回"是否已设置"；sshKey 回路径+指纹；写入前备份、写完回读校验。
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || '/home/zfq/.dsh'
const PLUGINS_ROOT = process.env.QQ_PLUGIN_SOURCES || '/home/zfq/dev/dsh-plugins'
const SECRET_RE = /(token|secret|password|passwd|api_?key|private_?key)/i

/**
 * 字段目录：给"读不到插件 schema"的插件补上类型/说明（本机现有插件实测都不导出 Config）。
 * 没在这里出现的键会按当前值猜类型（bool/number/text），布尔也能正确渲染成开关。
 */
const FIELD_CATALOG = {
  'ecs-n8n-gh': {
    ecsHost: { label: 'ECS 主机', type: 'text', desc: 'SSH 目标地址' },
    ecsUser: { label: '登录用户', type: 'text' },
    ecsPort: { label: 'SSH 端口', type: 'number', def: 22 },
    sshKey: { label: 'SSH 私钥路径', type: 'path', desc: '只存路径，不存私钥内容；可查指纹/测连通性' },
    deployDir: { label: '部署目录', type: 'path' },
    composeFile: { label: 'compose 文件', type: 'text' },
    n8nContainer: { label: 'n8n 容器名', type: 'text' },
    workspace: { label: '本地工作区', type: 'path' },
    ghRepo: { label: 'GitHub 仓库', type: 'text' },
    maxOutput: { label: '输出上限（字符）', type: 'number', def: 30000 },
  },
  'context-handoff': {
    availableRatio: { label: '触发水位（0~1）', type: 'number', desc: '上下文剩这么多就交接' },
    autoContinue: { label: '自动接续', type: 'bool' },
    freezeParent: { label: '冻结父会话', type: 'bool' },
    freezeTools: { label: '冻结工具', type: 'bool' },
    continueMode: { label: '接续方式', type: 'select', options: ['fresh', 'resume'] },
    digestMaxChars: { label: '摘要上限（字符）', type: 'number' },
    claimWindowMs: { label: '认领窗口（毫秒）', type: 'number' },
    claimCommitMs: { label: '提交窗口（毫秒）', type: 'number' },
    requireConsumer: { label: '必须有人认领', type: 'bool' },
    excludePresets: { label: '排除的 preset', type: 'list' },
    stateFile: { label: '状态文件', type: 'path' },
  },
  'session-reader': {
    allowedSessions: { label: '允许读取的会话', type: 'list' },
  },
}

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

const patchFile = () => join(DSH_HOME, 'cordis.patch.yml')
const readPatch = () => (existsSync(patchFile()) ? readFileSync(patchFile(), 'utf8') : '')
const writePatch = (text) => writeFileSync(patchFile(), text)
function backupPatch() {
  const file = patchFile()
  const backup = `${file}.bak-console-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(file, backup)
  return backup
}

/** 把一个键的 YAML 值渲染成 patch 里惯用的写法（字符串加单引号）。 */
function renderValue(value) {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map((v) => renderValue(v)).join(', ')}]`
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/** 解析 patch 里的插件块（含每个键的原始值），返回 [{ id, name, startLine, endLine, disabled, keys: {k:v}, blockText }]。 */
export function parseBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const idm = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[i])
    if (idm) {
      if (cur) { cur.endLine = i - 1; blocks.push(cur) }
      cur = { id: idm[1].replace(/^['"]|['"]$/g, ''), name: '', startLine: i, endLine: lines.length - 1, disabled: false, keys: {} }
      continue
    }
    if (!cur) continue
    const nm = /^\s*name:\s*(.+?)\s*$/.exec(lines[i])
    if (nm && cur.name === '') cur.name = nm[1].replace(/^['"]|['"]$/g, '')
    const dm = /^\s*disabled:\s*true\s*$/i.exec(lines[i])
    if (dm) cur.disabled = true
    const km = /^\s{6,}([\w.-]+):\s*(.*)$/.exec(lines[i])
    if (km && !['name', 'id', 'disabled', 'config'].includes(km[1])) cur.keys[km[1]] = km[2].replace(/^['"]|['"]$/g, '')
  }
  if (cur) { cur.endLine = lines.length - 1; blocks.push(cur) }
  for (const b of blocks) b.blockText = lines.slice(b.startLine, b.endLine + 1).join('\n')
  return blocks
}

/** 脱敏后的配置文本（给"原始配置"折叠加载用；sshKey 是路径所以保留）。 */
export function redactText(text) {
  return String(text ?? '').split('\n').map((line) => {
    const m = /^(\s*[\w.-]+:\s*)(\S.*)$/.exec(line)
    if (!m) return line
    if (!SECRET_RE.test(m[1]) || /sshkey/i.test(m[1])) return line
    return `${m[1]}<已设置，已隐藏>`
  }).join('\n')
}

/** 把一个插件的字段渲染成前端表单描述（类型来自目录，缺失则按当前值推断）。 */
export function describeFields(id, keys = {}) {
  const catalog = FIELD_CATALOG[id] ?? {}
  const names = new Set([...Object.keys(catalog), ...Object.keys(keys)])
  const fields = []
  for (const key of names) {
    const meta = catalog[key] ?? {}
    const raw = keys[key]
    let type = meta.type
    if (!type) {
      if (/^(true|false)$/i.test(String(raw ?? ''))) type = 'bool'
      else if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) type = 'number'
      else type = 'text'
    }
    const secret = SECRET_RE.test(key)
    const value = raw === undefined ? (meta.def ?? '') : raw
    fields.push({
      key,
      label: meta.label ?? key,
      type,
      desc: meta.desc ?? '',
      options: meta.options ?? [],
      secret,
      hasValue: raw !== undefined && raw !== '',
      value: secret ? '' : String(value ?? ''),
      inCatalog: Boolean(catalog[key]),
    })
  }
  return fields
}

/** 本机有哪些可装的本地插件（~/dev/dsh-plugins 下的目录）+ 已装状态。 */
export function listCandidates() {
  const installed = new Set(readdirSync(join(DSH_HOME, 'plugins')).filter((n) => !n.startsWith('.')).map((n) => n.replace(/^dsh-/, '')))
  const dirs = []
  for (const name of existsSync(PLUGINS_ROOT) ? readdirSync(PLUGINS_ROOT) : []) {
    const full = join(PLUGINS_ROOT, name)
    try { if (!statSync(full).isDirectory()) continue } catch { continue }
    const pkg = readJsonSafe(join(full, 'package.json'))
    if (!pkg) continue
    dirs.push({
      source: full,
      name,
      id: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : name,
      version: pkg.version ?? '',
      description: typeof pkg.description === 'string' ? pkg.description.slice(0, 100) : '',
      installed: installed.has(name.replace(/^dsh-/, '')),
    })
  }
  return dirs.sort((a, b) => a.name.localeCompare(b.name))
}

/** 插件列表（插件维度）：id/名称/来源/版本/启用/断链/可配置字段数。 */
export async function listPlugins() {
  const profileDir = join(DSH_HOME, 'profiles', 'web')
  const profilePkg = readJsonSafe(join(profileDir, 'package.json')) ?? {}
  const dshNodeModules = '/home/zfq/node24/lib/node_modules/@deepseek-ai/dsh/node_modules'
  const bundles = (profilePkg?.dsh?.profile?.bundles ?? []).map((name) => {
    const inProfile = existsSync(join(profileDir, 'node_modules', name))
    return { name, kind: 'bundle', source: inProfile ? 'profile 依赖' : 'dsh 内置', version: readJsonSafe(join(inProfile ? join(profileDir, 'node_modules') : dshNodeModules, name, 'package.json'))?.version ?? '' }
  })

  const blocks = parseBlocks(readPatch())
  const localNames = existsSync(join(DSH_HOME, 'plugins')) ? readdirSync(join(DSH_HOME, 'plugins')).filter((n) => !n.startsWith('.') && !/\.bak/.test(n)) : []
  const localById = new Map(localNames.map((n) => [n.replace(/^dsh-/, ''), n]))

  const plugins = []
  for (const b of blocks) {
    const localName = localById.get(b.id)
    const linkPath = localName ? join(DSH_HOME, 'plugins', localName) : ''
    let broken = false
    let version = ''
    if (linkPath) {
      try { broken = lstatSync(linkPath).isSymbolicLink() && !existsSync(linkPath) } catch { broken = true }
      version = readJsonSafe(join(linkPath, 'package.json'))?.version ?? ''
    }
    plugins.push({
      id: b.id,
      kind: 'local',
      name: b.name,
      version,
      source: linkPath || b.name,
      enabled: !b.disabled,
      broken,
      fieldCount: Object.keys(b.keys).length,
      configFile: patchFile(),
    })
  }
  for (const b of bundles) {
    plugins.push({ id: b.name, kind: 'bundle', name: b.name, version: b.version, source: b.source, enabled: true, broken: false, fieldCount: 0, configFile: join(profileDir, 'cordis.patch.yml'), managed: 'bundle' })
  }

  const credentialsFile = join(DSH_HOME, '.credentials.yaml')
  const credentialsText = existsSync(credentialsFile) ? readFileSync(credentialsFile, 'utf8') : ''
  return {
    ok: true,
    plugins,
    candidates: listCandidates(),
    secrets: {
      credentialsFile,
      credentialKeys: [...credentialsText.matchAll(/^\s{2}([A-Z0-9_]+):/gm)].map((m) => m[1]),
      napcatWebuiToken: Boolean(readJsonSafe('/home/zfq/dshbot/qq/napcat-config/webui.json')?.token),
    },
    roots: { dshHome: DSH_HOME, pluginSources: PLUGINS_ROOT },
  }
}

/** 单个插件详情：启用状态 + 配置字段（密钥不回明文）+ 脱敏原文。 */
export function pluginDetail(id) {
  const block = parseBlocks(readPatch()).find((b) => b.id === id)
  if (!block) return { ok: false, error: `没有这个插件：${id}` }
  return {
    ok: true,
    id,
    name: block.name,
    enabled: !block.disabled,
    fields: describeFields(id, block.keys),
    redacted: redactText(block.blockText),
    configFile: patchFile(),
  }
}

/** 批量保存配置：只改已存在的键；空值的密钥字段跳过（表示"不改"）；先备份再回读。 */
export function savePluginConfig({ id, values = {} }) {
  const file = patchFile()
  if (!existsSync(file)) return { ok: false, error: `找不到 ${file}` }
  const text = readFileSync(file, 'utf8')
  const block = parseBlocks(text).find((b) => b.id === id)
  if (!block) return { ok: false, error: `patch 里没有插件 ${id}` }
  const lines = text.split('\n')
  const changed = []
  const skipped = []
  for (const [key, value] of Object.entries(values)) {
    const secret = SECRET_RE.test(key)
    if (secret && (value === '' || value === undefined || value === null)) { skipped.push(key); continue }
    const re = new RegExp(`^(\\s{6,})${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.*)$`)
    let hit = -1
    for (let i = block.startLine + 1; i <= block.endLine && i < lines.length; i++) if (re.test(lines[i])) { hit = i; break }
    if (hit === -1) { skipped.push(`${key}(不存在)`); continue }
    lines[hit] = lines[hit].replace(re, `$1${key}: ${renderValue(value)}`)
    changed.push(key)
  }
  if (changed.length === 0) return { ok: false, error: `没有可改的字段（跳过：${skipped.join(', ') || '无'}）` }
  const backup = backupPatch()
  writePatch(lines.join('\n'))
  const after = parseBlocks(readPatch()).find((b) => b.id === id)
  const verified = changed.every((key) => Object.hasOwn(after?.keys ?? {}, key))
  return { ok: verified, changed, skipped, backup, file, note: '改完需要重启宿主（或 profile 热重载）才生效' }
}

/** 启用/禁用：patch 块里加/删 `disabled: true`。 */
export function setPluginEnabled({ id, enabled }) {
  const file = patchFile()
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const block = parseBlocks(text).find((b) => b.id === id)
  if (!block) return { ok: false, error: `patch 里没有插件 ${id}` }
  let disabledLine = -1
  for (let i = block.startLine + 1; i <= block.endLine && i < lines.length; i++) if (/^\s*disabled:\s*(true|false)\s*$/i.test(lines[i])) { disabledLine = i; break }
  const backup = backupPatch()
  if (enabled) {
    if (disabledLine >= 0) lines.splice(disabledLine, 1)
  } else if (disabledLine >= 0) {
    lines[disabledLine] = lines[disabledLine].replace(/disabled:\s*(true|false)/i, 'disabled: true')
  } else {
    // 插在 name 或 id 行之后，保持缩进
    const indent = '      '
    const at = lines[block.startLine].match(/^(\s*)/)?.[1] ?? '    '
    lines.splice(block.startLine + 1, 0, `${indent}disabled: true`)
  }
  writePatch(lines.join('\n'))
  const after = parseBlocks(readPatch()).find((b) => b.id === id)
  return { ok: Boolean(after) && after.disabled !== Boolean(enabled), enabled: !after?.disabled, backup, note: '改完需要重启宿主才生效' }
}

/** 安装：把插件源目录软链进 ~/.dsh/plugins，并在 home patch 追加一个 insert 块。 */
export function installPlugin({ source, enable = true }) {
  const src = String(source ?? '').trim()
  const allowedRoots = String(process.env.QQ_PLUGIN_ALLOWED_ROOTS || '/home/zfq:/opt:/srv').split(':').filter(Boolean)
  if (!src || !allowedRoots.some((root) => src === root || src.startsWith(`${root}/`))) {
    return { ok: false, error: `只允许从这些根目录安装：${allowedRoots.join('、')}（可用 QQ_PLUGIN_ALLOWED_ROOTS 扩展）` }
  }
  if (!existsSync(src)) return { ok: false, error: `目录不存在：${src}` }
  const pkg = readJsonSafe(join(src, 'package.json'))
  if (!pkg) return { ok: false, error: '该目录没有 package.json，看起来不是 DSH 插件' }
  const entry = existsSync(join(src, 'index.js')) ? 'index.js' : (pkg.main ?? '')
  if (!entry || !existsSync(join(src, entry))) return { ok: false, error: '找不到插件入口（index.js 或 package.json main）' }
  const dirName = String(pkg.name ?? basename(src)).replace(/^@[^/]+\//, '')
  const id = dirName.replace(/^dsh-/, '')
  const link = join(DSH_HOME, 'plugins', dirName)
  if (existsSync(link)) return { ok: false, error: `已经存在：${link}（先卸载或改名）` }
  const text = readPatch()
  if (parseBlocks(text).some((b) => b.id === id)) return { ok: false, error: `patch 里已经有 ${id}` }
  const backup = backupPatch()
  symlinkSync(src, link)
  const block = [
    '',
    '# >>> dsh-plugins: ' + id + ' >>>',
    '- insert:',
    '    - id: ' + id,
    '      name: ./plugins/' + dirName + '/index.js',
    '      config: {}',
    enable ? '' : '      disabled: true',
    '# <<< dsh-plugins: ' + id + ' <<<',
    '',
  ].filter((line) => line !== '').join('\n')
  writePatch(text.replace(/\n?$/, '\n') + block + '\n')
  return { ok: true, id, link, backup, note: '已写入配置；重启宿主后生效。配置字段可在列表里点「配置」补全。' }
}

/** 卸载：从 patch 移除该块；可选删掉 ~/.dsh/plugins 下的软链（**不删源目录**）。 */
export function uninstallPlugin({ id, removeLink = true }) {
  const file = patchFile()
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const block = parseBlocks(text).find((b) => b.id === id)
  if (!block) return { ok: false, error: `patch 里没有插件 ${id}` }
  const backup = backupPatch()
  let from = block.startLine
  let to = block.endLine
  // 连同上下紧邻的注释标记一起删（我们安装时写的 >>> / <<< 注释）
  while (from - 1 >= 0 && /^\s*#.*(dsh-plugins|>>>|<<<)/.test(lines[from - 1])) from--
  while (to + 1 < lines.length && /^\s*#.*(dsh-plugins|>>>|<<<)/.test(lines[to + 1])) to++
  lines.splice(from, to - from + 1)
  writePatch(lines.join('\n'))
  let linkRemoved = false
  if (removeLink) {
    const localName = (existsSync(join(DSH_HOME, 'plugins')) ? readdirSync(join(DSH_HOME, 'plugins')) : []).find((n) => n.replace(/^dsh-/, '') === id)
    if (localName) {
      const link = join(DSH_HOME, 'plugins', localName)
      try {
        if (lstatSync(link).isSymbolicLink()) { unlinkSync(link); linkRemoved = true }
      } catch { /* 忽略：不可删就留着 */ }
    }
  }
  return { ok: true, backup, linkRemoved, note: '已从配置移除；源目录保留（未删除）。重启宿主后生效。' }
}

export async function keyFingerprint(keyPath) {
  if (!keyPath || !existsSync(keyPath)) return { ok: false, error: 'key 文件不存在' }
  const r = await run('ssh-keygen', ['-lf', keyPath], 6000)
  return r.ok ? { ok: true, fingerprint: r.stdout.trim() } : { ok: false, error: r.stderr.trim() || 'ssh-keygen 失败' }
}

export async function sshTest({ host, user, port = 22, keyPath, timeoutSeconds = 5 }) {
  if (!host || !user) return { ok: false, error: '要提供 host 和 user' }
  const args = ['-i', keyPath || '/dev/null', '-p', String(port), '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeoutSeconds}`, '-o', 'StrictHostKeyChecking=accept-new', `${user}@${host}`, 'echo CONSOLE_SSH_OK; hostname']
  const r = await run('ssh', args, (timeoutSeconds + 4) * 1000)
  const out = `${r.stdout}${r.stderr}`.trim()
  return { ok: r.ok && r.stdout.includes('CONSOLE_SSH_OK'), output: out.slice(0, 800) }
}
