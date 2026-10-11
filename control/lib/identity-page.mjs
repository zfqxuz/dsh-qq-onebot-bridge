/**
 * "机器人身份"页的数据层（[本地补丁 阶段 2] 2026-10-12）
 *
 * 用户要求（原话）：QQ 号这些**一定不能写死**，并且**可在控制台修改**，因为不同人
 * 登录会登录他们自己的账号；出厂状态就是"没配 = 谁都不放行"，而不是内置某个人的号。
 *
 * 作用对象是**用户自己的 profile 配置**（<DSH_HOME>/profiles/<profile>/cordis.patch.yml）
 * 里 `id: dsh-qq-onebot-bridge` 那个块 —— 也就是桥接插件的 config。镜像里没有配置，
 * 所以换镜像不会碰到它；这里也只改下面这几个键，其余（persona/vision/acl/preset…）一字不动：
 *
 *   allowUsers / allowGroups / botQq      私聊与群白名单、机器人自己的号
 *   identity.enabled                      false = 一键回退到"所有人都是 owner"（旧行为）
 *   identity.map / groupRoles             QQ 号 / 群号 → 角色
 *   identity.defaultRole / groupRole      未列出者的默认角色
 *
 * 编辑策略：**逐行改**（保留注释与顺序），改前备份、改后回读校验；只新增缺失的行，
 * 绝不覆盖用户没让我们改的值。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, profileName } from './paths.mjs'
import {
  findBlock, findConfigLine, findSection, parseList, rewriteEntries,
  scalar, sectionEntries, sectionScalar, setScalar, setSectionScalar,
} from './patch-edit.mjs'

const BRIDGE_ID = process.env.QQ_BRIDGE_PLUGIN_ID || 'dsh-qq-onebot-bridge'

/** 桥接插件配置所在的 profile patch 文件。 */
export const profilePatchFile = () => join(dshHome, 'profiles', profileName, 'cordis.patch.yml')

/** 本文件只认桥接插件块的 id。 */
const blockOf = (lines) => findBlock(lines, BRIDGE_ID)

/** roles: 段里的角色名列表（写校验用；读不到就退回内置两个角色名）。 */
function roleNames(lines, block) {
  const identity = findSection(lines, 'identity', { from: block.start, to: block.end })
  if (!identity) return ['owner', 'guest']
  const roles = findSection(lines, 'roles', { from: identity.start, to: identity.end })
  if (!roles) return ['owner', 'guest']
  const names = []
  for (let i = roles.start + 1; i < roles.end; i++) {
    const m = /^(\s*)([A-Za-z0-9_-]+):\s*$/.exec(lines[i])
    if (m && m[1].length === roles.indent + 2) names.push(m[2])
  }
  return names.length > 0 ? names : ['owner', 'guest']
}

/** 读取当前身份配置（只读，任何解析失败都不抛）。 */
export function readIdentity() {
  const file = profilePatchFile()
  const exists = existsSync(file)
  const text = exists ? readFileSync(file, 'utf8') : ''
  const lines = text.split('\n')
  const block = blockOf(lines)
  const roles = block ? roleNames(lines, block) : ['owner', 'guest']
  if (!block) {
    return {
      ok: true, file, exists: false, blockFound: false, roles,
      allowUsers: [], allowGroups: [], botQq: 0,
      identity: { enabled: null, map: {}, defaultRole: '', groupRole: '', groupRoles: {} },
      unconfigured: true,
      note: `在 ${file} 里没找到 id: ${BRIDGE_ID} 这个插件块（桥接可能还没装到这个 profile）。`,
    }
  }
  const identity = findSection(lines, 'identity', { from: block.start, to: block.end })
  const allowUsers = parseList(scalar(lines, block, 'allowUsers'))
  const allowGroups = parseList(scalar(lines, block, 'allowGroups'))
  const botQqRaw = scalar(lines, block, 'botQq')
  const botQq = /^-?\d+$/.test(botQqRaw) ? Number(botQqRaw) : 0
  const enabledRaw = identity ? sectionScalar(lines, identity, 'enabled') : ''
  const result = {
    ok: true,
    file,
    exists: true,
    blockFound: true,
    roles,
    allowUsers,
    allowGroups,
    botQq,
    identity: {
      enabled: enabledRaw === '' ? null : enabledRaw === 'true',
      map: identity ? sectionEntries(lines, identity, 'map') : {},
      defaultRole: identity ? sectionScalar(lines, identity, 'defaultRole') : '',
      groupRole: identity ? sectionScalar(lines, identity, 'groupRole') : '',
      groupRoles: identity ? sectionEntries(lines, identity, 'groupRoles') : {},
    },
    unconfigured: allowUsers.length === 0 && allowGroups.length === 0,
    note: '',
  }
  return result
}

// ---------------- 写入 ----------------

const asIntList = (list) => `[${(list ?? []).map((v) => Number(v)).filter((n) => Number.isInteger(n)).join(', ')}]`

/**
 * 保存身份配置。
 * 入参只认这几个键；合法的 QQ/群号用整数，角色名要在 roles 里存在。
 * @returns {{ok:boolean, changed?:string[], skipped?:string[], warnings?:string[], backup?:string, file?:string, error?:string, note?:string}}
 */
export function saveIdentity(payload = {}) {
  const file = profilePatchFile()
  if (!existsSync(file)) return { ok: false, error: `找不到 ${file}` }
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const block = blockOf(lines)
  if (!block) return { ok: false, error: `文件里没有 id: ${BRIDGE_ID} 的块` }
  const configLine = findConfigLine(lines, block)
  const known = roleNames(lines, block)

  const warnings = []
  const parseIdList = (value, label) => {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，;；]+/)
    const out = []
    for (const item of raw) {
      const id = String(item).trim()
      if (id === '') continue
      if (!/^\d+$/.test(id)) { warnings.push(`${label} 里忽略非纯数字项：${id}`); continue }
      out.push(Number(id))
    }
    return out
  }
  const users = parseIdList(payload.allowUsers, '私聊白名单')
  const groups = parseIdList(payload.allowGroups, '群白名单')
  const botQqRaw = String(payload.botQq ?? '').trim()
  const botQq = botQqRaw === '' ? 0 : (Number.isInteger(Number(botQqRaw)) ? Number(botQqRaw) : NaN)
  if (Number.isNaN(botQq)) return { ok: false, error: `botQq 必须是整数，收到：${botQqRaw}` }

  const map = {}
  for (const [id, role] of Object.entries(payload.map ?? {})) {
    const qq = String(id).trim()
    const name = String(role ?? '').trim()
    if (qq === '' || name === '') continue
    if (!/^\d+$/.test(qq)) { warnings.push(`忽略非数字 QQ 号：${qq}`); continue }
    if (!known.includes(name)) { warnings.push(`忽略未知角色：${name}（可用：${known.join(' / ')}）`); continue }
    map[qq] = name
  }
  const groupRoles = {}
  for (const [id, role] of Object.entries(payload.groupRoles ?? {})) {
    const gid = String(id).trim()
    const name = String(role ?? '').trim()
    if (gid === '' || name === '') continue
    if (!/^\d+$/.test(gid)) { warnings.push(`忽略非数字群号：${gid}`); continue }
    if (!known.includes(name)) { warnings.push(`忽略未知角色：${name}（可用：${known.join(' / ')}）`); continue }
    groupRoles[gid] = name
  }
  const pickRole = (value, fallback, label) => {
    const name = String(value ?? '').trim()
    if (name === '') return fallback
    if (!known.includes(name)) { warnings.push(`${label} 用未知角色 ${name}，保持原值`); return '' }
    return name
  }

  const changed = []
  const mark = (key, result) => { if (result !== '') changed.push(key) }

  // 1) 白名单与机器人号
  mark('allowUsers', setScalar(lines, block, configLine, 'allowUsers', asIntList(users)))
  mark('allowGroups', setScalar(lines, block, configLine, 'allowGroups', asIntList(groups)))
  if (payload.botQq !== undefined) mark('botQq', setScalar(lines, block, configLine, 'botQq', String(botQq === 0 ? 0 : botQq)))

  // 2) identity 段
  const needsIdentity = payload.defaultRole !== undefined || payload.groupRole !== undefined
    || payload.map !== undefined || payload.groupRoles !== undefined || payload.identityEnabled !== undefined
  if (needsIdentity) {
    let identity = findSection(lines, 'identity', { from: block.start, to: block.end })
    if (!identity) {
      const indent = ' '.repeat(indentOf(lines[configLine >= 0 ? configLine : block.start]) + 2)
      const at = configLine >= 0 ? configLine + 1 : block.end
      lines.splice(at, 0, `${indent}identity:`)
      block.end += 1
      identity = findSection(lines, 'identity', { from: block.start, to: block.end })
    }
    if (payload.identityEnabled !== undefined) {
      mark('identity.enabled', setSectionScalar(lines, identity, 'enabled', payload.identityEnabled === true || payload.identityEnabled === 'true' ? 'true' : 'false'))
    }
    if (payload.defaultRole !== undefined) {
      const role = pickRole(payload.defaultRole, '', 'defaultRole')
      if (role !== '') mark('identity.defaultRole', setSectionScalar(lines, identity, 'defaultRole', role))
    }
    if (payload.groupRole !== undefined) {
      const role = pickRole(payload.groupRole, '', 'groupRole')
      if (role !== '') mark('identity.groupRole', setSectionScalar(lines, identity, 'groupRole', role))
    }
    if (payload.map !== undefined) mark('identity.map', rewriteEntries(lines, identity, 'map', map))
    if (payload.groupRoles !== undefined) mark('identity.groupRoles', rewriteEntries(lines, identity, 'groupRoles', groupRoles))
  }

  // 安全提示（不阻断，只是让人看清自己选了什么）
  if (users.length === 0 && groups.length === 0) warnings.push('私聊与群白名单都是空的 —— 现在谁都不放行（这是安全的出厂状态）')
  const defaultRoleValue = String(payload.defaultRole ?? '').trim()
  const groupRoleValue = String(payload.groupRole ?? '').trim()
  if (defaultRoleValue.includes('owner')) warnings.push('defaultRole 是 owner：任何没列在白名单里的私聊号都会拿到主人权限')
  if (groupRoleValue.includes('owner')) warnings.push('groupRole 是 owner：任何允许的群里每个人都有主人权限')

  if (changed.length === 0) return { ok: false, error: '没有任何变化', warnings }

  const backup = `${file}.bak-identity-console-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(file, backup)
  writeFileSync(file, lines.join('\n'))

  const after = readIdentity()
  const verified = after.blockFound
    && after.allowUsers.length === users.length
    && after.allowGroups.length === groups.length
  return {
    ok: verified,
    changed,
    warnings,
    backup,
    file,
    result: after,
    note: '改完需要重启宿主（或 profile 热重载）才生效；本页只改白名单/角色，其它配置一字未动。',
  }
}
