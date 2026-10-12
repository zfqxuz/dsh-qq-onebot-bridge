#!/usr/bin/env node
/**
 * 首启播种（ensure-only，绝不 apply）—— [本地补丁 阶段 2] 2026-10-12
 *
 * 用户的硬约束（原话）："如果用户已经配置了，那即使更新镜像也不再重新配置。"
 * 所以这里的规矩只有一条：**键/块不存在才写入默认值；存在就整块不动**，
 * 判据是"有没有这一行"，不是"值空不空"（`allowUsers: []` 是用户故意清空，必须原样保留）。
 *
 * 做什么（只在 <DSH_HOME>/.seeded-<版本> 标记不存在时做）：
 *   1. profile 目录与 package.json（缺才建；bundles 里含桥接）
 *   2. profile/node_modules/dsh-qq-onebot-bridge 软链 → 镜像内 /app/bridge
 *   3. profile/cordis.patch.yml 里的桥接块（缺才追加；默认值全部是"没配"状态）
 *   4. home cordis.patch.yml 里的本地插件块（缺才追加）
 * 软链每次都修（它不是配置值）；文件内容只在没标记时碰。
 *
 * 用法：node qq-seed.mjs [--dry-run] [--dsh-home DIR] [--profile NAME] [--plugins DIR]
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, pluginSources, profileName, resolvePath } from '../lib/paths.mjs'
import { appendBlock, findBlock, findConfigLine, findSection, hasKey, setScalar } from '../lib/patch-edit.mjs'

/** 本仓库根（镜像里是 /app/bridge，宿主上是仓库目录）——由脚本位置推导，不写死。 */
const HERE = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const DRY = has('--dry-run')
const DSH = valueOf('--dsh-home', process.env.DSH_HOME || dshHome)
const PROFILE = valueOf('--profile', process.env.QQ_PROFILE || profileName)
const PLUGINS = valueOf('--plugins', process.env.QQ_PLUGINS_DIR || pluginSources)
const BRIDGE_DIR = resolve(valueOf('--bridge-dir', process.env.QQ_BRIDGE_DIR || join(HERE, '..', '..')))
const VERSION = process.env.QQ_VERSION || (() => {
  try { return JSON.parse(readFileSync(join(BRIDGE_DIR, 'package.json'), 'utf8')).version ?? 'unknown' } catch { return 'unknown' }
})()

/** 出厂就要挂上的本地插件（目录名 → 插件 id）。桥接内部直接 import 的库插件不在此列。 */
const SEED_PLUGINS = (process.env.QQ_SEED_PLUGINS || 'context-handoff,ecs-n8n-gh,session-reader')
  .split(',').map((item) => item.trim()).filter(Boolean)
  .map((item) => {
    const [dir, id] = item.split(':')
    return { dir, id: id || dir }   // id 与宿主机安装脚本一致（不带 dsh- 前缀），避免以后重复挂载
  })

const PROFILE_PACKAGE = {
  name: `dsh-profile-${PROFILE}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-qq-onebot-bridge'], patchReload: 'live' } },
}

/** 桥接出厂配置：只有端口与"没配"的白名单/角色，**没有任何 QQ 号、没有任何宿主路径**。 */
const BRIDGE_SEED_LINES = [
  'name: dsh-qq-onebot-bridge',
  'config:',
  '  port: 6700',
  '  # 白名单为空 = 谁都不放行（安全默认）。在控制台"机器人身份"页填自己的号。',
  '  allowUsers: []',
  '  allowGroups: []',
  '  botQq: 0',
  '  acceptPrivate: true',
  '  replyOnlyWhenMentioned: true',
  '  # [#权限模型] 权限库（<数据根>/config/acl.db）是控制台 8798 的启动前提；',
  '  # 库不存在时按下面的 identity / adminUsers 建库并导入一次（幂等，之后走库）。',
  '  aclEnabled: true',
  '  aclBootstrap: true',
  '  identity:',
  '    enabled: true',
  '    map: {}',
  '    defaultRole: guest',
  '    groupRole: guest',
  '    groupRoles: {}',
]

const kept = []
const seeded = []
const actions = []
const failures = []
const note = (list, item) => { if (!list.includes(item)) list.push(item) }

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}
function writeText(file, text) {
  if (DRY) { actions.push(`write ${file}`); return }
  writeFileSync(file, text)
}
function ensureDir(dir) {
  if (existsSync(dir)) { note(kept, `dir:${dir}`); return }
  note(seeded, `dir:${dir}`)
  if (!DRY) mkdirSync(dir, { recursive: true })
  else actions.push(`mkdir ${dir}`)
}
/** 软链：不是配置值，每次都可以修正；只在"确实不对"时动。 */
function ensureSymlink(link, target) {
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) { note(kept, `link:${link}`); return }
  } catch { /* 不存在或不是软链 */ }
  note(seeded, `link:${link}`)
  if (DRY) { actions.push(`ln -sfn ${target} ${link}`); return }
  try {
    try { unlinkSync(link) } catch { /* ignore */ }
    symlinkSync(target, link)
  } catch (error) {
    // 软链失败不该拦住启动：记下来、继续 —— 真要报错也是 dsh 装载插件时的事
    failures.push(`${link}: ${error?.message ?? error}`)
  }
}

// ---------- 1) profile 目录与 package.json ----------
const profileDir = join(DSH, 'profiles', PROFILE)
ensureDir(join(DSH, 'profiles'))
ensureDir(profileDir)
ensureDir(join(DSH, 'plugins'))
const profilePkgFile = join(profileDir, 'package.json')
if (!existsSync(profilePkgFile)) {
  note(seeded, `package.json:bundles(含桥接)`)
  writeText(profilePkgFile, `${JSON.stringify(PROFILE_PACKAGE, null, 2)}\n`)
} else {
  note(kept, 'package.json')
}

// ---------- 2) 软链：profile 里的桥接 + 各本地插件 ----------
ensureDir(join(profileDir, 'node_modules'))
ensureSymlink(join(profileDir, 'node_modules', 'dsh-qq-onebot-bridge'), BRIDGE_DIR)
for (const { dir } of SEED_PLUGINS) {
  const source = join(PLUGINS, dir)
  if (!existsSync(source)) continue
  ensureSymlink(join(DSH, 'plugins', dir), source)
}

// ---------- 3) profile patch 里的桥接块（缺才追加；存在则只补缺失的键） ----------
const markerFile = join(DSH, `.seeded-${VERSION}`)
if (existsSync(markerFile)) {
  note(kept, `seeded-marker:${VERSION}（已播种过，跳过内容写入）`)
} else {
  const profilePatch = join(profileDir, 'cordis.patch.yml')
  const text = readText(profilePatch)
  const lines = text === '' ? ['# 由 qq-seed 生成：用户自己的 profile 配置层，升级镜像不会覆盖这里的值。'] : text.split('\n')
  if (text === '') note(seeded, 'profile-patch:新建文件')

  const block = findBlock(lines, 'dsh-qq-onebot-bridge')
  if (!block) {
    appendBlock(lines, 'dsh-qq-onebot-bridge', BRIDGE_SEED_LINES)
    note(seeded, 'bridge-block(整个块)')
  } else {
    // 块在 = 用户配过；只补缺失的键，绝不改已有值
    const configLine = findConfigLine(lines, block)
    const ensureKey = (key, raw) => {
      if (hasKey(lines, block, key)) { note(kept, key); return }
      setScalar(lines, block, configLine, key, raw)
      note(seeded, key)
    }
    ensureKey('port', '6700')
    ensureKey('allowUsers', '[]')
    ensureKey('allowGroups', '[]')
    ensureKey('botQq', '0')
    const identity = findSection(lines, 'identity', { from: block.start, to: block.end })
    if (!identity) {
      const configIndent = configLine >= 0 ? (lines[configLine].match(/^\s*/) ?? [''])[0].length : 2
      const indent = ' '.repeat(configIndent + 2)
      const at = configLine >= 0 ? configLine + 1 : block.end
      lines.splice(at, 0, `${indent}identity:`, `${indent}  enabled: true`, `${indent}  defaultRole: guest`, `${indent}  groupRole: guest`)
      note(seeded, 'identity(整个段)')
    }
  }
  writeText(profilePatch, `${lines.join('\n').replace(/\n+$/, '')}\n`)

  // ---------- 4) home patch 里的本地插件块 ----------
  const homePatch = join(DSH, 'cordis.patch.yml')
  const homeText = readText(homePatch)
  const homeLines = homeText === '' ? ['# DSH home-level user patch layer（由 qq-seed 建；用户配置不会被镜像覆盖）。'] : homeText.split('\n')
  if (homeText === '') note(seeded, 'home-patch:新建文件')
  for (const { dir, id } of SEED_PLUGINS) {
    if (!existsSync(join(PLUGINS, dir))) continue
    if (findBlock(homeLines, id)) { note(kept, `plugin-block:${id}`); continue }
    if (homeLines.length > 0 && homeLines[homeLines.length - 1].trim() !== '') homeLines.push('')
    homeLines.push('- insert:', `    - id: ${id}`, `      name: ./plugins/${dir}/index.js`)
    note(seeded, `plugin-block:${id}`)
  }
  writeText(homePatch, `${homeLines.join('\n').replace(/\n+$/, '')}\n`)

  if (!DRY) writeFileSync(markerFile, `seeded ${VERSION} at ${new Date().toISOString()}\n`)
}

// ---------- 3.5) 权限库不存在时补 aclEnabled / aclBootstrap（不受播种标记约束） ----------
// [fix 2026-10-12] 真机踩到：全新 Windows 装完，控制台 8798 一点就"拒绝连接"。
//   原因：控制台启动前要求 <数据根>/config/acl.db 存在（不存在就退出），而库是桥接按 aclBootstrap 建的；
//   出厂配置里没这两行 → 没人建库 → 控制台起不来，也没入口去建库（死锁）。
//   上面那段内容写入被 .seeded-<版本> 标记挡着（老安装升级时不会重跑），所以这里单独补一次。
//   仍然只"补缺"：库已存在（用户自己在用）或键已存在（用户自己配过）一律不碰。
{
  const dataRoot = valueOf('--data-root', '') || resolvePath('QQ_DATA_ROOT', [join(process.env.USERPROFILE || process.env.HOME || '.', 'qqbot')])
  const aclFile = join(dataRoot, 'config', 'acl.db')
  if (existsSync(aclFile)) {
    note(kept, 'acl.db（已存在：不动 aclEnabled / aclBootstrap）')
  } else {
    const profilePatchFile = join(profileDir, 'cordis.patch.yml')
    const lines = readText(profilePatchFile).split('\n')
    const bridgeBlock = lines.length > 0 ? findBlock(lines, 'dsh-qq-onebot-bridge') : null
    if (bridgeBlock) {
      const configLine = findConfigLine(lines, bridgeBlock)
      let changed = false
      for (const [key, raw] of [['aclEnabled', 'true'], ['aclBootstrap', 'true']]) {
        if (hasKey(lines, bridgeBlock, key)) { note(kept, key); continue }
        setScalar(lines, bridgeBlock, configLine, key, raw)
        note(seeded, key)
        changed = true
      }
      if (changed) writeText(profilePatchFile, `${lines.join('\n').replace(/\n+$/, '')}\n`)
    }
  }
}

// ---------- 报告 ----------
if (DRY && actions.length > 0) for (const action of actions) console.log(`[seed] dry-run: ${action}`)
console.log(`[seed] kept: ${kept.length} 项 / seeded: ${seeded.length} 项${seeded.length > 0 ? `（${seeded.join('、')}）` : ''}`)
console.log(`[seed] 标记文件：${markerFile}${existsSync(markerFile) ? '（存在：不再动配置内容）' : '（不存在：下次启动会再补缺）'}`)
if (failures.length > 0) console.log(`[seed] 警告（不影响启动）：${failures.join('；')}`)
