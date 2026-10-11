/**
 * 系统配置渲染器（共享实现）—— [本地补丁 阶段 5] 2026-10-12
 *
 * 用户的定性（原话）："gh 应该是用户要在管理端手动配置的""工作目录绑定 … 这些都应该是
 * 系统配置的一部分"。所以这里把「系统配置 → 容器里的真实文件」这一步抽出来，供两处调用：
 *   1) 控制台保存时（console 容器与 harness 共用同一个数据卷 → base 部署写完即可用）
 *   2) harness 容器每次启动时（control/bin/qq-system-config.mjs 调它，保证重装/换镜像后仍一致）
 *
 * 铁律（沿用首启播种的既有约定）：
 *   - **只补缺，不覆盖**：git 身份键已存在、gh 该 host 已有 token → 一律保留；
 *     唯一例外是 system.json 里明确给了新 token（那是用户刚在控制台输入的意图）。
 *   - **外部挂载优先**：GIT_CONFIG_GLOBAL / GH_CONFIG_DIR 由环境显式指定（dev 覆盖模式
 *     挂了宿主配置）时，跳过写入并在报告里说明，绝不偷偷改宿主的凭据。
 *   - **绝不出密钥**：报告里只有掩码和动作，token 原文只写进目标文件（0600）。
 *   - 任何失败都不抛给调用方（渲染失败不该拖垮启动），一律转成报告里的 error 文本。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/** 镜像里 gh 的固定位置（Dockerfile.harness 装到 /usr/local/bin/gh）。 */
const GH_BIN = process.env.QQ_GH_BIN || '/usr/local/bin/gh'

const str = (v) => String(v ?? '').trim()

/** token 掩码：只给头尾各 4 位 + 长度，任何日志/接口都用它。 */
export function maskToken(token) {
  const t = str(token)
  if (t === '') return ''
  return `${t.slice(0, 4)}…${t.slice(-4)}（${t.length} 字符）`
}

/** 原子的写文件：先写同目录临时文件再 rename，避免半截文件被读到。 */
function writeFileAtomic(file, text, mode) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${Date.now()}.tmp`)
  writeFileSync(tmp, text)
  if (mode !== undefined) chmodSync(tmp, mode)
  renameSync(tmp, file)
  if (mode !== undefined) chmodSync(file, mode)
}

/** 备份 + 覆盖：只在真的要改已有文件时调用。 */
function backupThen(file, text, mode) {
  let backup = ''
  if (existsSync(file)) {
    backup = `${file}.bak-syscfg-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(file, backup)
  }
  writeFileAtomic(file, text, mode)
  return backup
}

/** 极简 hosts.yml 解析：只要 host 段的 oauth_token / user 和 users 段，够做"只补缺"判断即可。 */
export function parseGhHosts(text) {
  const hosts = {}
  let host = null
  let user = null
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const body = line.trim()
    if (body === '' || body.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const m = /^([^:]+):\s*(.*)$/.exec(body)
    if (!m) continue
    const [, key, value] = m
    if (indent === 0) { host = key; user = null; hosts[host] = { token: '', user: '', gitProtocol: '', users: {} }; continue }
    if (host === null) continue
    if (indent === 4 && key === 'users') continue
    if (indent === 8 && key !== 'oauth_token' && key !== 'user') { user = key; hosts[host].users[user] = ''; continue }
    if (indent >= 12 && user !== null && key === 'oauth_token') { hosts[host].users[user] = value; continue }
    if (key === 'oauth_token') hosts[host].token = value
    else if (key === 'user') hosts[host].user = value
    else if (key === 'git_protocol') hosts[host].gitProtocol = value
  }
  return hosts
}

/** 生成 gh 认得的 hosts.yml（缩进与 gh 自己写的一致）。 */
export function renderGhHosts({ host, login, token }) {
  return [
    `${host}:`,
    '    users:',
    `        ${login}:`,
    `            oauth_token: ${token}`,
    '    git_protocol: https',
    `    oauth_token: ${token}`,
    `    user: ${login}`,
    '',
  ].join('\n')
}

/** 读 .gitconfig 里已有的身份（只看 [user] 段，够做"只补缺"判断）。 */
function readGitIdentity(file) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return { name: '', email: '', exists: false } }
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
  return { name, email, exists: true }
}

function gitConfigSet(file, key, value) {
  execFileSync('git', ['config', '--file', file, key, value], { stdio: 'pipe', timeout: 8000 })
}

function gitConfigGetAll(file, key) {
  try {
    const out = execFileSync('git', ['config', '--file', file, '--get-all', key], { stdio: 'pipe', timeout: 8000 })
    return String(out).split('\n').map((l) => l.trim()).filter(Boolean)
  } catch { return [] }
}

/**
 * 渲染系统配置。参数全是显式路径（不猜环境），返回值就是给控制台/日志看的报告。
 *
 * @param {object} o
 * @param {object} o.config         system.json 的内容（已 normalize）
 * @param {string} o.home           容器内 HOME（base 部署是数据根）
 * @param {string} o.gitConfigFile  目标 .gitconfig
 * @param {string} o.ghDir          目标 gh 配置目录
 * @param {string} [o.workspaceActual] 容器当前启动用的工作区（QQ_WORKSPACE）
 * @param {boolean} [o.externalGit]  GIT_CONFIG_GLOBAL 是否由外部显式指定（dev 覆盖）
 * @param {boolean} [o.externalGh]   GH_CONFIG_DIR 是否由外部显式指定（dev 覆盖）
 * @param {boolean} [o.dryRun]
 * @param {string} [o.source]        'boot' | 'console'
 */
export function applySystemConfig(o) {
  const {
    config = {}, home = '', gitConfigFile = '', ghDir = '',
    workspaceActual = '', externalGit = false, externalGh = false,
    dryRun = false, source = 'boot',
  } = o

  const git = { userName: str(config?.git?.userName), userEmail: str(config?.git?.userEmail) }
  const github = { host: str(config?.github?.host) || 'github.com', login: str(config?.github?.login), token: str(config?.github?.token) }

  const report = {
    at: Date.now(),
    source,
    dryRun: Boolean(dryRun),
    home,
    gitconfig: gitConfigFile,
    ghDir,
    git: { action: 'no-config', name: git.userName, email: git.userEmail, detail: '系统配置里没有 git 身份（保持现状）' },
    gh: { action: 'no-token', host: github.host, login: github.login, tokenHint: maskToken(github.token), detail: '系统配置里没有 gh 凭据（保持现状）' },
    workspace: { actual: workspaceActual, desired: str(config?.workspace?.path), effective: workspaceActual, pending: false, reason: '' },
  }

  // ---- 1) git 身份 ----
  try {
    if (git.userName === '' && git.userEmail === '') {
      report.git.action = 'no-config'
    } else if (externalGit) {
      report.git.action = 'skipped-external'
      report.git.detail = 'GIT_CONFIG_GLOBAL 由外部挂载指定（开发模式）→ 不动宿主 gitconfig'
    } else {
      const before = readGitIdentity(gitConfigFile)
      const seedName = git.userName !== '' && before.name === '' ? git.userName : ''
      const seedEmail = git.userEmail !== '' && before.email === '' ? git.userEmail : ''
      if (seedName === '' && seedEmail === '') {
        report.git.action = 'kept'
        report.git.detail = `已存在 user.name/user.email（${before.name || '-'} / ${before.email || '-'}）→ 保留`
      } else if (dryRun) {
        report.git.action = 'dry-run'
        report.git.detail = `将写入 ${[seedName && 'user.name', seedEmail && 'user.email'].filter(Boolean).join('、')}`
      } else {
        mkdirSync(dirname(gitConfigFile), { recursive: true })
        const existed = existsSync(gitConfigFile)
        if (existed) copyFileSync(gitConfigFile, `${gitConfigFile}.bak-syscfg-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        if (seedName !== '') gitConfigSet(gitConfigFile, 'user.name', seedName)
        if (seedEmail !== '') gitConfigSet(gitConfigFile, 'user.email', seedEmail)
        report.git.action = 'seeded'
        report.git.detail = `写入 ${[seedName && 'user.name', seedEmail && 'user.email'].filter(Boolean).join('、')}`
      }
    }
  } catch (error) {
    report.git.action = 'error'
    report.git.detail = `写 gitconfig 失败：${String(error?.message ?? error).slice(0, 200)}`
  }

  // ---- 2) git 凭据助手（让 git push 用得上 gh 的 token；只补缺） ----
  report.credential = { action: 'skip', detail: '' }
  try {
    if (externalGit) {
      report.credential = { action: 'skipped-external', detail: 'gitconfig 由外部挂载指定 → 不动' }
    } else if (github.token === '') {
      report.credential = { action: 'no-token', detail: '没有 gh 凭据 → 不配凭据助手' }
    } else if (!existsSync(GH_BIN)) {
      report.credential = { action: 'no-gh-bin', detail: `找不到 ${GH_BIN} → 不配凭据助手` }
    } else {
      const key = `credential.https://${github.host}.helper`
      const existing = gitConfigGetAll(gitConfigFile, key)
      if (existing.length > 0) {
        report.credential = { action: 'kept', detail: `已有凭据助手（${existing.join(' ')}）→ 保留` }
      } else if (dryRun) {
        report.credential = { action: 'dry-run', detail: `将写入 helper = !${GH_BIN} auth git-credential` }
      } else {
        gitConfigSet(gitConfigFile, key, '')
        gitConfigSet(gitConfigFile, key, `!${GH_BIN} auth git-credential`)
        report.credential = { action: 'seeded', detail: `写入 helper = !${GH_BIN} auth git-credential` }
      }
    }
  } catch (error) {
    report.credential = { action: 'error', detail: `写凭据助手失败：${String(error?.message ?? error).slice(0, 200)}` }
  }

  // ---- 3) gh 凭据 ----
  try {
    const hostsFile = join(ghDir, 'hosts.yml')
    if (github.token === '') {
      report.gh.action = 'no-token'
    } else if (externalGh) {
      report.gh.action = 'skipped-external'
      report.gh.detail = 'GH_CONFIG_DIR 由外部挂载指定（开发模式）→ 不改宿主 gh 凭据'
    } else if (github.login === '') {
      report.gh.action = 'need-login'
      report.gh.detail = '有 token 但没填 GitHub 账号名 → 不落盘（gh 的 hosts.yml 需要账号名）'
    } else {
      const existing = existsSync(hostsFile) ? parseGhHosts(readFileSync(hostsFile, 'utf8')) : {}
      const current = existing[github.host] ?? { token: '', user: '', users: {} }
      if (current.token === github.token) {
        report.gh.action = 'kept'
        report.gh.detail = `hosts.yml 里 ${github.host} 已是同一个 token → 保留`
      } else if (dryRun) {
        report.gh.action = 'dry-run'
        report.gh.detail = `将写入 ${hostsFile}（mode 600）`
      } else {
        const backup = backupThen(hostsFile, renderGhHosts({ host: github.host, login: github.login, token: github.token }), 0o600)
        chmodSync(ghDir, 0o700)
        report.gh.action = 'seeded'
        report.gh.detail = `写入 ${hostsFile}（mode 600${backup ? `，原文件备份 ${backup}` : ''}）`
      }
    }
  } catch (error) {
    report.gh.action = 'error'
    report.gh.detail = `写 gh 凭据失败：${String(error?.message ?? error).slice(0, 200)}`
  }

  // ---- 4) 工作区：容器里能到达且可写才优先（挂载本身由 compose/.env 决定） ----
  const desired = str(config?.workspace?.path)
  const ws = report.workspace
  if (desired === '') {
    ws.reason = '未配置工作区 → 用 .env 的 QQ_WORKSPACE'
  } else if (desired === workspaceActual) {
    ws.effective = desired
    ws.reason = '与当前挂载一致'
  } else if (!existsSync(desired)) {
    // 目录不存在：父目录可写就替用户建出来（在控制台刚绑的新目录，不该再要求他去宿主 mkdir）
    const parent = dirname(desired)
    let created = false
    if (!dryRun && parent !== desired && existsSync(parent)) {
      try { mkdirSync(desired); created = true } catch { created = false }
    }
    if (created) {
      ws.effective = desired
      ws.reason = '容器内原本没有，已按配置创建（父目录可写）→ 本次启动即采用'
    } else {
      ws.reason = `配置的路径在容器里不存在（${desired}），父目录也不可写 → 需要先在宿主建好，或把 QQ_WORKSPACE_ROOT 调大后重建`
    }
  } else {
    let writable = true
    try { const probe = mkdtempSync(join(desired, '.dsh-ws-probe-')) ; rmSync(probe, { recursive: true, force: true }) } catch { writable = false }
    if (writable) {
      ws.effective = desired
      ws.reason = '容器内可达且可写 → 本次启动即采用'
    } else {
      ws.reason = `配置的路径只读（${desired}）→ DSH 会在只读工作区里跑；请在控制台/挂载里改成可写目录`
    }
  }
  ws.pending = desired !== '' && ws.effective !== desired

  return report
}
