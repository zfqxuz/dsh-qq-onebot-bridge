/**
 * 系统配置（控制台侧数据层）—— [本地补丁 阶段 5] 2026-10-12
 *
 * 用户的要求（原话）："gh 应该是用户要在管理端手动配置的""工作目录绑定 … 这些都应该是
 * 系统配置的一部分"。本模块负责那份「系统配置」的唯一落盘位置与校验：
 *
 *   <数据根>/config/system.json      ← 用户意图（控制台写，随数据卷走，换镜像不丢）
 *   <数据根>/state/system-config.json ← 渲染报告（容器启动时写，控制台只读）
 *   <数据根>/logs/console-audit.jsonl ← 谁在什么时候改了什么（不含密钥）
 *
 * 分工（别越界）：
 *   - 本模块：读写 system.json + 校验 + 备份 + 审计 + （保存后）把配置渲染进数据卷，
 *     让 base 部署**保存即生效**（控制台与 harness 共用同一个数据卷）。
 *   - control/bin/qq-system-config.mjs：容器每次启动时再渲染一遍（宿主机/挂载变过也不会漂）。
 *   - 工作区能否真正切换还取决于挂载，所以这里只保证"在可写范围内"+"启动时实测"。
 *
 * 出厂状态：文件不存在 = 全部为空 = 「未配置」，不写任何默认凭据。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataRoot } from './paths.mjs'
import { applySystemConfig, maskToken, parseGhHosts } from './system-config-apply.mjs'

export const configDir = join(dataRoot, 'config')
export const configFile = join(configDir, 'system.json')
export const reportFile = join(dataRoot, 'state', 'system-config.json')
export const workspaceEffectiveFile = join(dataRoot, 'state', 'workspace.effective')
export const auditFile = join(dataRoot, 'logs', 'console-audit.jsonl')

/** 出厂默认：全空。空 = 未配置 = 保持现状，不产生任何凭据。 */
export const EMPTY = Object.freeze({
  version: 1,
  git: { userName: '', userEmail: '' },
  github: { host: 'github.com', login: '', token: '' },
  workspace: { path: '' },
})

const str = (v) => String(v ?? '').trim()

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 规整成固定形状：缺字段补空，多余字段丢掉。 */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    version: 1,
    git: { userName: str(r.git?.userName), userEmail: str(r.git?.userEmail) },
    github: { host: str(r.github?.host) || 'github.com', login: str(r.github?.login), token: str(r.github?.token) },
    workspace: { path: str(r.workspace?.path) },
    updatedAt: Number(r.updatedAt ?? 0) || 0,
    updatedBy: str(r.updatedBy),
  }
}

/** 数据卷里的真实文件状态（base 部署下 harness 的 HOME 就是数据根，这两份就是它在用的）。 */
function volumeState() {
  const gitFile = join(dataRoot, '.gitconfig')
  const ghFile = join(dataRoot, '.config', 'gh', 'hosts.yml')
  let git = { exists: false, name: '', email: '' }
  try {
    const text = readFileSync(gitFile, 'utf8')
    let inUser = false
    let name = ''
    let email = ''
    for (const raw of text.split('\n')) {
      const body = raw.trim()
      if (body.startsWith('[')) { inUser = /^\[user\]/i.test(body); continue }
      if (!inUser) continue
      const m = /^(\w+)\s*=\s*(.*)$/.exec(body)
      if (!m) continue
      if (m[1].toLowerCase() === 'name') name = m[2].trim()
      if (m[1].toLowerCase() === 'email') email = m[2].trim()
    }
    git = { exists: true, name, email }
  } catch { /* 不存在就是未配置 */ }

  let gh = { exists: false, hosts: [] }
  try {
    const hosts = parseGhHosts(readFileSync(ghFile, 'utf8'))
    gh = {
      exists: true,
      hosts: Object.entries(hosts).map(([host, v]) => ({ host, login: v.user, tokenHint: maskToken(v.token), hasToken: v.token !== '' })),
    }
  } catch { /* 同上 */ }

  const mode = (file) => { try { return (statSync(file).mode & 0o777).toString(8) } catch { return '' } }
  return { gitconfig: { ...git, file: gitFile }, ghHosts: { ...gh, file: ghFile, mode: mode(ghFile) } }
}

/** 工作区三态：.env 挂载的（actual）、系统配置里写的（desired）、启动时实际采用的（effective）。 */
function workspaceState(config, report) {
  const actual = str(process.env.QQ_WORKSPACE)
  const root = str(process.env.QQ_WORKSPACE_ROOT) || actual
  const desired = str(config.workspace.path)
  const eff = str(report?.workspace?.effective) || actual
  const pending = desired !== '' && desired !== eff
  const composeHint = 'cd <部署目录> && docker compose up -d harness'
  return {
    actual,
    root,
    desired,
    effective: eff,
    pending,
    reason: str(report?.workspace?.reason),
    applyHint: pending
      ? `系统配置里要的是 ${desired}。容器挂载范围由 .env 的 QQ_WORKSPACE_ROOT 决定（当前 ${root}）：` +
        `只要它在范围内，重启 harness 就会切过去；不在范围内就先改 .env 的 QQ_WORKSPACE_ROOT，然后 ${composeHint}`
      : '',
  }
}

/** 读系统配置：token 原文永不出这个模块，接口只回掩码。 */
export function readSystemConfig() {
  const raw = readJson(configFile, null)
  const config = normalize(raw)
  const report = readJson(reportFile, null)
  const token = config.github.token
  const audit = (() => {
    try {
      return readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).slice(-10)
        .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
    } catch { return [] }
  })()

  return {
    ok: true,
    dataRoot,
    configFile,
    reportFile,
    exists: raw !== null,
    config: {
      git: { ...config.git },
      github: { host: config.github.host, login: config.github.login, tokenSet: token !== '', tokenHint: maskToken(token) },
      workspace: { ...config.workspace },
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    },
    workspace: workspaceState(config, report),
    report,
    volume: volumeState(),
    audit,
  }
}

/** 工作区路径校验：形状 + 必须在可写挂载范围内。真正的"可写"由容器启动时实测。 */
export function validateWorkspacePath(input) {
  const p = str(input)
  if (p === '') return { ok: true, value: '' }
  if (!p.startsWith('/')) return { ok: false, error: '必须是宿主绝对路径（以 / 开头）' }
  if (p === '/') return { ok: false, error: '不能是根目录 /' }
  if (p.includes('\n') || p.includes('\0')) return { ok: false, error: '路径里不能有换行/空字符' }
  if (p.split('/').includes('..')) return { ok: false, error: '路径里不能有 ..' }
  const clean = p.replace(/\/+$/, '')
  if (clean === '/data' || clean.startsWith('/data/')) {
    return { ok: false, error: '/data/... 是容器内部路径，工作区要填宿主路径' }
  }
  const root = str(process.env.QQ_WORKSPACE_ROOT) || str(process.env.QQ_WORKSPACE)
  if (root !== '' && !(clean === root || clean.startsWith(`${root}/`))) {
    return {
      ok: false,
      error: `超出可写范围：当前挂载的可写范围是 ${root}。要绑到范围外，先在部署目录的 .env 里把 QQ_WORKSPACE_ROOT 改成更大的目录，再重建 harness`,
    }
  }
  return { ok: true, value: clean }
}

/** 校验一个 GitHub token 是否可用（控制台有网，用它顺手把账号名填上）。 */
export async function probeGithubToken({ host = 'github.com', token }) {
  const t = str(token)
  if (t === '') return { ok: false, error: '没有 token' }
  const base = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
  try {
    const res = await fetch(`${base}/user`, {
      headers: { authorization: `token ${t}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-qq-console' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, error: `GitHub 返回 HTTP ${res.status}（token 可能不对或没权限）` }
    const body = await res.json()
    return { ok: true, login: str(body.login), scopes: str(res.headers.get('x-oauth-scopes')) }
  } catch (error) {
    return { ok: false, error: `校验失败（网络？）：${String(error?.message ?? error).slice(0, 120)}` }
  }
}

function audit(entry) {
  try {
    mkdirSync(dirname(auditFile), { recursive: true })
    appendFileSync(auditFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
  } catch { /* 审计失败不该拖垮保存 */ }
}

/**
 * 保存系统配置。字段是可选的：只处理请求里出现的键，没出现的保持原样。
 * github.token 为空字符串 = 不改；clearGithubToken=true = 清空。
 */
export function saveSystemConfig({ values = {}, user = '' } = {}) {
  const current = normalize(readJson(configFile, null))
  const next = normalize(current)
  const changed = []
  const rejected = []
  const warnings = []

  const setText = (label, path, value, max = 200) => {
    const v = str(value)
    if (v.length > max) { rejected.push(`${label}(太长)`); return }
    const before = path === 'git.userName' ? next.git.userName
      : path === 'git.userEmail' ? next.git.userEmail
        : path === 'github.host' ? next.github.host
          : path === 'github.login' ? next.github.login : ''
    if (before === v) return
    if (path === 'git.userName') next.git.userName = v
    if (path === 'git.userEmail') next.git.userEmail = v
    if (path === 'github.host') next.github.host = v
    if (path === 'github.login') next.github.login = v
    changed.push(label)
  }

  if ('gitUserName' in values) setText('git.userName', 'git.userName', values.gitUserName)
  if ('gitUserEmail' in values) {
    const email = str(values.gitUserEmail)
    if (email !== '' && !/^[^@\s]+@[^@\s]+$/.test(email)) warnings.push('git 邮箱看起来不像邮箱（仍按你填的保存）')
    setText('git.userEmail', 'git.userEmail', email)
  }
  if ('githubHost' in values) {
    const host = str(values.githubHost) || 'github.com'
    if (!/^[a-z0-9.-]+$/i.test(host)) rejected.push('github.host(格式不对)')
    else setText('github.host', 'github.host', host)
  }
  if ('githubLogin' in values) {
    const login = str(values.githubLogin)
    if (login !== '' && !/^[A-Za-z0-9-]+$/.test(login)) rejected.push('github.login(只允许字母数字和 -)')
    else setText('github.login', 'github.login', login)
  }
  if ('githubToken' in values) {
    const token = str(values.githubToken)
    if (token !== '') {
      if (/\s/.test(token)) rejected.push('github.token(不能含空白字符)')
      else if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token)) {
        warnings.push('token 形状不像 GitHub 官方 token（仍按你填的保存；企业版/自建可能不同）')
        next.github.token = token
        changed.push('github.token')
      } else {
        next.github.token = token
        changed.push('github.token')
      }
    }
  }
  if (values.clearGithubToken === true && next.github.token !== '') {
    next.github.token = ''
    changed.push('github.token(已清空)')
  }
  if ('workspacePath' in values) {
    const v = validateWorkspacePath(values.workspacePath)
    if (!v.ok) rejected.push(`workspace.path(${v.error})`)
    else if (v.value !== next.workspace.path) { next.workspace.path = v.value; changed.push('workspace.path') }
  }

  if (changed.length === 0) {
    return { ok: false, error: `没有可写项${rejected.length ? `：${rejected.join('；')}` : '（值没变化）'}`, rejected, warnings }
  }

  next.updatedAt = Date.now()
  next.updatedBy = str(user)
  mkdirSync(configDir, { recursive: true })
  let backup = ''
  if (existsSync(configFile)) {
    backup = `${configFile}.bak-console-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(configFile, backup)
  }
  writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`)
  audit({ user, action: 'system.settings.save', changed, backup })

  // 保存即渲染（base 部署下控制台与 harness 共用数据卷 → 立即生效；dev 模式的差异由启动报告说明）
  const apply = applyToVolume(next)
  return {
    ok: true,
    changed,
    rejected,
    warnings,
    backup,
    apply,
    note: '已保存。git 身份与 gh 凭据已渲染进数据卷（容器下一次读文件即生效）；工作区变更需要重启 harness 才会切换。',
    config: readSystemConfig().config,
  }
}

/** 把配置渲染到数据卷（= base 部署下 harness 的 HOME）。控制台与 harness 共用同一卷。 */
export function applyToVolume(config, { dryRun = false } = {}) {
  return applySystemConfig({
    config,
    home: dataRoot,
    gitConfigFile: join(dataRoot, '.gitconfig'),
    ghDir: join(dataRoot, '.config', 'gh'),
    workspaceActual: str(process.env.QQ_WORKSPACE),
    externalGit: false,     // 控制台写的就是数据卷这份，不受容器环境变量影响
    externalGh: false,
    dryRun,
    source: 'console',
  })
}
