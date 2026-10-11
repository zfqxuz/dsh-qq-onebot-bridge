#!/usr/bin/env node
/**
 * ACL 库命令行（控制台的"无界面版"，两者共用 lib/acl-store.js）。
 *
 *   node control/bin/qq-acl.mjs init                    # 建库 + 内置角色 + 权限点镜像
 *   node control/bin/qq-acl.mjs import-config <json>     # 从配置（identity/adminUsers）导入分配
 *   node control/bin/qq-acl.mjs show                     # 打印角色 / 分配 / deny
 *   node control/bin/qq-acl.mjs export > acl.json        # 导出快照
 *   node control/bin/qq-acl.mjs assign group:2001 guest
 *   node control/bin/qq-acl.mjs grant guest cmd.image
 *   node control/bin/qq-acl.mjs revoke guest cmd.image
 *   node control/bin/qq-acl.mjs deny user:1001 tool.shell
 *   node control/bin/qq-acl.mjs audit [n]
 *
 * 默认库文件：$QQ_ACL_DB 或 <数据根>/config/acl.db（--file 可覆盖）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePath } from '../lib/paths.mjs'
import { openAclStore } from '../../lib/acl-store.js'
import { PERMISSIONS, isKnownPermission } from '../../lib/permissions.js'

const args = process.argv.slice(2)
const take = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = args[i + 1]
  args.splice(i, value && !value.startsWith('--') ? 2 : 1)
  return value && !value.startsWith('--') ? value : ''
}
const file = take('file') || process.env.QQ_ACL_DB || join(resolvePath('QQ_DATA_ROOT', ['/data/qqbot', join(process.env.HOME || homedir(), 'qqbot')]), 'config', 'acl.db')
const command = (args.shift() ?? 'show').toLowerCase()
const rest = args
const ACTOR = `cli:${process.env.USER ?? 'unknown'}`

function need() {
  if (!existsSync(file) && command !== 'init') {
    console.error(`ACL 库不存在：${file}\n先跑：node control/bin/qq-acl.mjs init --file ${file}`)
    process.exit(2)
  }
}
function badPermission(list) {
  const bad = list.filter((id) => !isKnownPermission(id))
  if (bad.length > 0) {
    console.error(`词表里没有这些权限点（拒绝写入）：${bad.join(', ')}`)
    console.error(`可用权限点（${PERMISSIONS.length} 个）：${PERMISSIONS.map((p) => p.id).join(' ')}`)
    process.exit(2)
  }
}

need()
const store = openAclStore(file)
try {
  if (command === 'init') {
    const n = store.syncPermissions()
    const roles = store.seedBuiltinRoles({ force: args.includes('--force') })
    store.audit({ actor: ACTOR, action: 'init', target: file, after: { permissions: n, roles } })
    console.log(`已初始化：${file}\n权限点镜像 ${n} 个，内置角色落库 ${roles} 个`)
  } else if (command === 'import-config') {
    const json = rest.join(' ')
    if (json.trim() === '') { console.error('用法：import-config \'{"identity":{...},"adminUsers":[...]}\''); process.exit(2) }
    const rows = store.importAssignmentsFromConfig(JSON.parse(json))
    store.audit({ actor: ACTOR, action: 'import-config', target: file, after: { rows } })
    console.log(`已导入 ${rows} 条主体→角色分配`)
  } else if (command === 'show') {
    const policy = store.loadPolicy()
    for (const [id, role] of Object.entries(policy.roles)) {
      console.log(`角色 ${id}（${role.name ?? ''}）：权限 ${role.permissions.length} 项`
        + `${role.denies.length ? `，deny ${role.denies.length} 项` : ''}`)
    }
    const assignments = Object.entries(policy.assignments)
    console.log(`\n分配（${assignments.length} 个主体）：`)
    for (const [subject, roles] of assignments) console.log(`  ${subject} → ${roles.join(' + ')}`)
    const denies = Object.entries(policy.subjectDenies)
    if (denies.length > 0) {
      console.log('\n主体级 deny：')
      for (const [subject, perms] of denies) console.log(`  ${subject} ✗ ${perms.join(', ')}`)
    }
    console.log(`\n默认角色：人=${policy.defaultRoleByKind.user} 群=${policy.defaultRoleByKind.group}`)
  } else if (command === 'export') {
    console.log(JSON.stringify(store.exportJson(), null, 2))
  } else if (command === 'assign') {
    const [subject, ...roles] = rest
    if (!subject || roles.length === 0) { console.error('用法：assign <subject> <role...>'); process.exit(2) }
    console.log(`已设置 ${subject} → ${store.setSubjectRoles(subject, roles, { actor: ACTOR }).join(' + ')}`)
  } else if (command === 'grant' || command === 'revoke') {
    const [role, ...perms] = rest
    if (!role || perms.length === 0) { console.error(`用法：${command} <role> <permission...>`); process.exit(2) }
    badPermission(perms)
    const current = store.loadPolicy().roles[role]
    if (!current) { console.error(`角色不存在：${role}`); process.exit(2) }
    const next = command === 'grant'
      ? [...new Set([...current.permissions, ...perms])]
      : current.permissions.filter((id) => !perms.includes(id))
    store.setRolePermissions(role, next, { actor: ACTOR })
    console.log(`${role} 现在有 ${next.length} 项权限`)
  } else if (command === 'deny' || command === 'undeny') {
    const [subject, ...perms] = rest
    if (!subject || perms.length === 0) { console.error(`用法：${command} <subject> <permission...>`); process.exit(2) }
    badPermission(perms)
    const current = store.loadPolicy().subjectDenies[subject] ?? []
    const next = command === 'deny' ? [...new Set([...current, ...perms])] : current.filter((id) => !perms.includes(id))
    store.setSubjectDenies(subject, next, { actor: ACTOR })
    console.log(`${subject} 的 deny 现在有 ${next.length} 项`)
  } else if (command === 'audit') {
    const rows = store.auditTail(Number(rest[0]) || 20)
    for (const row of rows) {
      const at = new Date(Number(row.at)).toISOString().replace('T', ' ').slice(0, 19)
      console.log(`${at} ${row.actor} ${row.action} ${row.target}`)
    }
  } else {
    console.error(`未知命令：${command}（可用：init / import-config / show / export / assign / grant / revoke / deny / undeny / audit）`)
    process.exit(2)
  }
} finally {
  store.close()
}
