/**
 * 系统配置测试（[本地补丁 阶段 5] 2026-10-12）
 *
 * 守的是用户提的硬要求（原话）：
 *   1. "gh 应该是用户要在管理端手动配置的" —— 出厂不能带任何凭据，配了才生效；
 *   2. "如果用户在控制台绑定了 dsh 工作目录，那他应该是可写的" —— 只读/不可达的工作区不许采用；
 *   3. 老规矩不破：**只补缺，不覆盖**（用户手改过的 git 身份、已有 token 一律保留）。
 *
 * 逐条验证：
 *   - system.json 的读写/掩码/校验/备份（控制台数据层）
 *   - gh hosts.yml 的渲染与"已有 token 不覆盖"
 *   - git 身份的"只补缺"、凭据助手的幂等
 *   - 工作区三态与可写判定（含父目录可写时自动创建）
 *   - 开发模式（GIT_CONFIG_GLOBAL/GH_CONFIG_DIR 由外部指定）时一律跳过
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const REPO = join(fileURLToPath(import.meta.url), '..', '..')
const tmp = mkdtempSync(join(tmpdir(), 'qq-syscfg-test-'))
// gh 可执行文件的位置：容器里是 /usr/local/bin/gh，开发机 / CI 上不一定在那儿 ——
// 以前这台机器上跑就有 2 条"环境性失败"，看着像代码坏了。这里明确指定一个存在的桩文件
// （模块在 import 时读 QQ_GH_BIN，所以必须在 import 之前设好）。
const ghStubDir = join(tmp, 'bin')
mkdirSync(ghStubDir, { recursive: true })
const ghStub = join(ghStubDir, 'gh')   // 文件名必须是 gh：断言里比的是 "... gh auth git-credential"
writeFileSync(ghStub, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
process.env.QQ_GH_BIN = ghStub
const { applySystemConfig, parseGhHosts, renderGhHosts } = await import(join(REPO, 'control/lib/system-config-apply.mjs'))

const newDir = (name) => { const d = mkdtempSync(join(tmp, `${name}-`)); return d }

// ---------- A. hosts.yml 解析 ----------
{
  const real = ['github.com:', '    users:', '        octocat:', '            oauth_token: gho_abc123', '    git_protocol: https', '    oauth_token: gho_abc123', '    user: octocat', ''].join('\n')
  const parsed = parseGhHosts(real)
  check('hosts.yml 解析：host 段 token/user', parsed['github.com']?.token === 'gho_abc123' && parsed['github.com']?.user === 'octocat')
  const round = parseGhHosts(renderGhHosts({ host: 'github.com', login: 'someone', token: 'ghp_xyz' }))
  check('hosts.yml 渲染→解析 往返一致', round['github.com']?.token === 'ghp_xyz' && round['github.com']?.user === 'someone')
}

// ---------- B. 渲染器：只补缺 + 工作区可写 ----------
{
  const home = newDir('home')
  const base = { home, gitConfigFile: join(home, '.gitconfig'), ghDir: join(home, '.config', 'gh'), workspaceActual: '/tmp/ws-mounted' }

  // B1 空配置：什么都不写
  const r1 = applySystemConfig({ ...base, config: {} })
  check('空配置：git=no-config / gh=no-token', r1.git.action === 'no-config' && r1.gh.action === 'no-token')
  check('空配置：不产生 .gitconfig / hosts.yml', !existsSync(base.gitConfigFile) && !existsSync(join(base.ghDir, 'hosts.yml')))

  // B2 给了 git 身份 → 写入；再跑一次 → 保留
  const cfgGit = { git: { userName: 'octocat', userEmail: 'octocat@users.noreply.github.com' } }
  const r2 = applySystemConfig({ ...base, config: cfgGit })
  const gitText = readFileSync(base.gitConfigFile, 'utf8')
  check('git 身份：首次写入', r2.git.action === 'seeded' && gitText.includes('octocat') && gitText.includes('noreply'))
  const r3 = applySystemConfig({ ...base, config: cfgGit })
  check('git 身份：第二次保留（不重复写）', r3.git.action === 'kept')

  // B3 用户手改过的身份不被覆盖
  const edited = gitText.replace('octocat@users.noreply.github.com', 'me@example.com')
  writeFileSync(base.gitConfigFile, edited)
  applySystemConfig({ ...base, config: { git: { userName: 'OTHER', userEmail: 'other@example.com' } } })
  check('git 身份：用户手改过 → 一个字不动', readFileSync(base.gitConfigFile, 'utf8') === edited)

  // B4 gh 凭据：写入 0600 + 第二次保留
  const cfgGh = { github: { host: 'github.com', login: 'octocat', token: 'ghp_testtoken1234567890' } }
  const r4 = applySystemConfig({ ...base, config: cfgGh })
  const hostsFile = join(base.ghDir, 'hosts.yml')
  const mode = (statSync(hostsFile).mode & 0o777).toString(8)
  check('gh 凭据：首次写入 + 0600', r4.gh.action === 'seeded' && mode === '600', `mode=${mode}`)
  check('gh 凭据：token 只落盘、不进报告', !JSON.stringify(r4).includes('ghp_testtoken1234567890') && r4.gh.tokenHint.startsWith('ghp_'))
  const r5 = applySystemConfig({ ...base, config: cfgGh })
  check('gh 凭据：同一个 token 第二次保留', r5.gh.action === 'kept')

  // B5 token 但没账号名 → 不落盘
  const ghDir2 = join(newDir('gh2'), 'gh')
  const r6 = applySystemConfig({ ...base, ghDir: ghDir2, config: { github: { host: 'github.com', login: '', token: 'ghp_x' } } })
  check('gh 凭据：缺账号名 → need-login 不落盘', r6.gh.action === 'need-login' && !existsSync(join(ghDir2, 'hosts.yml')))

  // B6 凭据助手：有 token 时写入，第二次保留
  // .gitconfig 是 INI：键名会写成 [credential "https://github.com"] + helper = …
  const afterCred = readFileSync(base.gitConfigFile, 'utf8')
  check('git 凭据助手：写入 gh auth git-credential',
    afterCred.includes('[credential "https://github.com"]') && afterCred.includes('!') && afterCred.includes('gh auth git-credential'))
  const r7 = applySystemConfig({ ...base, config: cfgGh })
  check('git 凭据助手：第二次保留', r7.credential?.action === 'kept')

  // B7 开发模式（外部挂载）→ 一律跳过
  const devHome = newDir('devhome')
  const r8 = applySystemConfig({
    home: devHome, gitConfigFile: join(devHome, '.gitconfig'), ghDir: join(devHome, '.config', 'gh'),
    workspaceActual: '/tmp/ws',
    config: { git: { userName: 'octocat', userEmail: 'z@example.com' }, github: cfgGh.github },
    externalGit: true, externalGh: true,
  })
  check('开发模式：git/gh 都 skipped-external', r8.git.action === 'skipped-external' && r8.gh.action === 'skipped-external')
  check('开发模式：不写任何文件', !existsSync(join(devHome, '.gitconfig')) && !existsSync(join(devHome, '.config', 'gh', 'hosts.yml')))

  // B8 工作区：不存在但父目录可写 → 自动创建并采用
  const wsParent = newDir('ws')
  const wanted = join(wsParent, 'project-x')
  const r9 = applySystemConfig({ ...base, config: { workspace: { path: wanted } }, workspaceActual: '/tmp/old' })
  check('工作区：父目录可写 → 自动创建并采用', r9.workspace.effective === wanted && existsSync(wanted) && r9.workspace.pending === false)

  // B9 工作区：只读目录 → 不采用（pending）
  const ro = join(wsParent, 'readonly')
  mkdirSync(ro)
  chmodSync(ro, 0o555)
  const r10 = applySystemConfig({ ...base, config: { workspace: { path: ro } }, workspaceActual: '/tmp/old' })
  check('工作区：只读 → 不采用且标 pending', r10.workspace.effective === '/tmp/old' && r10.workspace.pending === true)
  chmodSync(ro, 0o755)

  // B10 工作区：与挂载值一致 → 直接采用、无 pending
  const r11 = applySystemConfig({ ...base, config: { workspace: { path: '/tmp/ws-mounted' } } })
  check('工作区：与挂载一致 → 采用且 pending=false', r11.workspace.effective === '/tmp/ws-mounted' && r11.workspace.pending === false)
}

// ---------- C. 控制台数据层：读写 / 掩码 / 校验 / 备份 ----------
{
  const dataRoot = newDir('data')
  const wsRoot = newDir('wsroot')
  process.env.QQ_DATA_ROOT = dataRoot
  process.env.QQ_WORKSPACE_ROOT = wsRoot
  process.env.QQ_WORKSPACE = join(wsRoot, 'workspace')
  mkdirSync(process.env.QQ_WORKSPACE)
  const sc = await import(join(REPO, 'control/lib/system-config.mjs'))

  const read0 = sc.readSystemConfig()
  check('控制台：出厂未配置', read0.ok && read0.exists === false && read0.config.github.tokenSet === false)

  const saved = sc.saveSystemConfig({
    values: {
      gitUserName: 'octocat', gitUserEmail: 'octocat@users.noreply.github.com',
      githubHost: 'github.com', githubLogin: 'octocat', githubToken: 'ghp_console1234567890',
      workspacePath: process.env.QQ_WORKSPACE,
    },
    user: 'tester',
  })
  check('控制台：保存成功并渲染', saved.ok === true && saved.changed.length >= 4 && saved.apply?.gh?.action === 'seeded', JSON.stringify(saved.changed))
  check('控制台：写了备份文件', saved.backup === '' || existsSync(saved.backup))
  const read1 = sc.readSystemConfig()
  check('控制台：读接口只回掩码（无 token 原文）',
    !JSON.stringify(read1).includes('ghp_console1234567890') && read1.config.github.tokenHint.startsWith('ghp_'))
  check('控制台：数据卷里真的落了 gh 凭据', read1.volume.ghHosts.exists === true && read1.volume.ghHosts.mode === '600')
  check('控制台：数据卷里真的落了 git 身份', read1.volume.gitconfig.exists === true && read1.volume.gitconfig.name === 'octocat')

  // 校验：范围外的工作区必须被拒
  const outside = sc.saveSystemConfig({ values: { workspacePath: '/etc/somewhere' }, user: 'tester' })
  check('控制台：范围外工作区被拒', outside.ok === false && String(outside.rejected?.join()).includes('超出可写范围'))
  // 校验：/data 容器内路径必须被拒
  const inner = sc.saveSystemConfig({ values: { workspacePath: '/data/qqbot/ws' }, user: 'tester' })
  check('控制台：容器内路径被拒', inner.ok === false)

  // 清空 token
  const cleared = sc.saveSystemConfig({ values: { clearGithubToken: true }, user: 'tester' })
  check('控制台：可清空 token', cleared.ok === true && sc.readSystemConfig().config.github.tokenSet === false)

  // 审计
  check('控制台：审计里不含 token', !readFileSync(sc.auditFile, 'utf8').includes('ghp_'))
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
