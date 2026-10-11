/**
 * 身份页 + 首启播种测试（[本地补丁 阶段 2] 2026-10-12）
 *
 * 守的是两条硬约束（用户原话）：
 *   1. QQ 号/白名单**不能写死**，出厂必须是"没配 = 谁都不放行"，且能在控制台改；
 *   2. 用户配过之后，**换镜像/升级也不能重新配置**（只补缺失的键，绝不覆盖已有值）。
 *
 * 所以这里逐条验证：
 *   - readIdentity 能从真实形态的 profile patch 里读出白名单/角色；
 *   - saveIdentity 只改它负责的那几行（块外内容逐字节不变），并拒绝非法输入；
 *   - 空数组是"用户故意清空"，升级后必须还是空数组；
 *   - qq-seed 首启补缺、第二次运行零改动、用户改过之后升级零改动。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const tmp = mkdtempSync(join(tmpdir(), 'qq-identity-test-'))

/** 造一个"用户已配过"的 profile home。 */
function makeHome({ patch }) {
  const home = mkdtempSync(join(tmp, 'home-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  const file = join(home, 'profiles', 'web', 'cordis.patch.yml')
  writeFileSync(file, patch)
  return { home, file }
}

const USER_PATCH = `# 我的 profile 配置（注释必须原样保留）
- id: dsh-qq-onebot-bridge
  name: dsh-qq-onebot-bridge
  config:
    port: 6700
    allowUsers: [10001]
    allowGroups: [20002]
    botQq: 30003
    identity:
      enabled: true
      map:
        "10001": owner
      defaultRole: guest
      groupRole: guest
      groupRoles:
        "20002": owner
      roles:
        owner:
          preset: qq-coding
        guest:
          preset: qq-readonly
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    model: deepseek-flash
`

function withHome(home, fn) {
  const oldDsh = process.env.DSH_HOME
  const oldProfile = process.env.QQ_PROFILE
  process.env.DSH_HOME = home
  process.env.QQ_PROFILE = 'web'
  return import(`../control/lib/identity-page.mjs?t=${Math.random()}`)
    .then(async (mod) => { try { return await fn(mod) } finally {
      if (oldDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldDsh
      if (oldProfile === undefined) delete process.env.QQ_PROFILE; else process.env.QQ_PROFILE = oldProfile
    } })
}

// ===== 1. 读 =====
{
  const { home } = makeHome({ patch: USER_PATCH })
  await withHome(home, (m) => {
    const r = m.readIdentity()
    check('读：白名单/群/机器人号', JSON.stringify([r.allowUsers, r.allowGroups, r.botQq]) === JSON.stringify([[10001], [20002], 30003]))
    check('读：角色映射', JSON.stringify(r.identity.map) === JSON.stringify({ 10001: 'owner' }))
    check('读：整群升级角色', JSON.stringify(r.identity.groupRoles) === JSON.stringify({ 20002: 'owner' }))
    check('读：默认角色', r.identity.defaultRole === 'guest' && r.identity.groupRole === 'guest')
    check('读：可用角色名来自 roles:', JSON.stringify(r.roles) === JSON.stringify(['owner', 'guest']))
    check('读：已配置', r.unconfigured === false)
  })
}

/** 去掉桥接块后的原文（用来断言"块外一字未动"）。 */
function stripBridgeBlock(text) {
  const out = []
  let inside = false
  for (const line of text.split('\n')) {
    if (/^-\s*id:\s*dsh-qq-onebot-bridge\s*$/.test(line)) { inside = true; continue }
    if (inside && /^-\s*id:\s*/.test(line)) inside = false
    if (!inside) out.push(line)
  }
  return out.join('\n')
}

// ===== 2. 写：只改该改的行，块外一字不动 =====
{
  const { home, file } = makeHome({ patch: USER_PATCH })
  const outsideBefore = stripBridgeBlock(readFileSync(file, 'utf8'))
  await withHome(home, (m) => {
    const w = m.saveIdentity({
      allowUsers: [10001, 10004], allowGroups: [20002], botQq: 30003,
      identityEnabled: true, defaultRole: 'guest', groupRole: 'guest',
      map: { 10001: 'owner', 10004: 'guest' }, groupRoles: {},
    })
    check('写：成功且回读校验通过', w.ok === true, JSON.stringify(w.changed))
    const r = m.readIdentity()
    check('写：白名单更新', JSON.stringify(r.allowUsers) === JSON.stringify([10001, 10004]))
    check('写：map 更新', JSON.stringify(r.identity.map) === JSON.stringify({ 10001: 'owner', 10004: 'guest' }))
    check('写：groupRoles 被清空', JSON.stringify(r.identity.groupRoles) === JSON.stringify({}))
    const text = readFileSync(file, 'utf8')
    check('写：注释保留', text.includes('# 我的 profile 配置（注释必须原样保留）'))
    check('写：块外内容一字未动', stripBridgeBlock(text) === outsideBefore)
    check('写：有备份文件', existsSync(w.backup))
  })
}

// ===== 3. 写：非法输入被挡住，而不是写进去 =====
{
  const { home, file } = makeHome({ patch: USER_PATCH })
  await withHome(home, (m) => {
    const w = m.saveIdentity({
      allowUsers: ['abc', '10001'], allowGroups: ['10002'], botQq: 30003,
      identityEnabled: true, defaultRole: 'guest', groupRole: 'guest',
      map: { 10002: 'superuser' }, groupRoles: {},
    })
    const r = m.readIdentity()
    check('写：非数字号被忽略并告警', r.allowUsers.includes(10001) && !r.allowUsers.some((v) => String(v) === 'abc') && w.warnings.join().includes('abc'))
    check('写：非数字群号被忽略', r.allowGroups.length === 0 || r.allowGroups.every((v) => Number.isInteger(v)))
    check('写：未知角色被拒绝', Object.values(r.identity.map).includes('superuser') === false && w.warnings.join().includes('superuser'))
    check('写：文件仍是合法 JSON 之外的原文（能再次读出）', readFileSync(file, 'utf8').includes('dsh-qq-onebot-bridge'))
  })
}

// ===== 4. 写：空白名单会被提示（安全默认，不是错误） =====
{
  const { home } = makeHome({ patch: USER_PATCH })
  await withHome(home, (m) => {
    const w = m.saveIdentity({ allowUsers: [], allowGroups: [], botQq: 0, identityEnabled: true, defaultRole: 'guest', groupRole: 'guest', map: {}, groupRoles: {} })
    const r = m.readIdentity()
    check('写：清空白名单后 unconfigured=true', r.unconfigured === true)
    check('写：给了"谁都不放行"提示', w.warnings.join().includes('谁都不放行'))
  })
}

// ===== 5. qq-seed：首启补缺 / 幂等 / 升级不覆盖 =====
{
  const seedHome = mkdtempSync(join(tmp, 'seed-'))
  const plugins = join(REPO, '..', 'dsh-plugins')
  const env = { ...process.env, DSH_HOME: seedHome, QQ_PROFILE: 'web', QQ_PLUGINS_DIR: plugins, QQ_VERSION: 'v9.9.9', QQ_BRIDGE_DIR: REPO }
  const runSeed = () => execFileSync(process.execPath, [join(REPO, 'control/bin/qq-seed.mjs')], { env, encoding: 'utf8' })
  const patchFile = join(seedHome, 'profiles', 'web', 'cordis.patch.yml')

  const first = runSeed()
  check('seed：首次确实播种了', first.includes('seeded:') && !first.includes('seeded: 0 项'))
  const text1 = readFileSync(patchFile, 'utf8')
  check('seed：出厂 allowUsers 为空', /allowUsers: \[\]/.test(text1))
  check('seed：出厂没有任何 QQ 号', !/\d{5,}/.test(text1), text1.match(/\d{5,}/)?.[0] ?? '')
  check('seed：出厂没有宿主绝对路径', !/\/home\//.test(text1))

  const second = runSeed()
  check('seed：第二次 0 改动（幂等）', second.includes('seeded: 0 项'), second.split('\n')[0])
  check('seed：文件字节未变', readFileSync(patchFile, 'utf8') === text1)

  // 用户配过 → 换版本（删标记）→ 必须原样保留
  writeFileSync(patchFile, text1.replace('allowUsers: []', 'allowUsers: [10001]').replace('botQq: 0', 'botQq: 30003'))
  rmSync(join(seedHome, '.seeded-v9.9.9'))
  const third = execFileSync(process.execPath, [join(REPO, 'control/bin/qq-seed.mjs')], { env: { ...env, QQ_VERSION: 'v9.9.10' }, encoding: 'utf8' })
  const after = readFileSync(patchFile, 'utf8')
  check('seed：升级后保留用户白名单', after.includes('allowUsers: [10001]'), third.split('\n')[0])
  check('seed：升级后保留用户机器人号', after.includes('botQq: 30003'))

  // 反向用例：用户故意清空 + 缺一个键 → 只补缺的那个键
  writeFileSync(patchFile, after.replace('allowUsers: [10001]', 'allowUsers: []').replace(/ {2}botQq: 30003\n/, ''))
  rmSync(join(seedHome, '.seeded-v9.9.10'))
  execFileSync(process.execPath, [join(REPO, 'control/bin/qq-seed.mjs')], { env: { ...env, QQ_VERSION: 'v9.9.11' }, encoding: 'utf8' })
  const last = readFileSync(patchFile, 'utf8')
  check('seed：空数组不会被"补回默认"', last.includes('allowUsers: []'))
  check('seed：缺失的键被补上', last.includes('botQq: 0'))
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
