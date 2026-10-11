/**
 * 权限控制台的 HTTP 面（本地、只绑 127.0.0.1、要 token）。
 *
 * 只做**权限管理**（zfq 2026-10-09 的要求：控制台不碰具体会话）：
 *   角色增删改、角色 × 权限矩阵（allow + deny）、主体分配、主体级 deny、限额、审计查询、导出快照。
 *
 * 安全模型沿用同仓的 control/lib/server.mjs：只绑回环、每个 /api/* 都要 token、
 * 带 Origin 的请求必须来自控制台页面本身（挡跨站）。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { canonicalRoleId, openAclStore } from '../../lib/acl-store.js'
import { resolveCorpusDetailed } from '../../lib/corpus.js'
import { PERMISSIONS, isKnownPermission } from '../../lib/permissions.js'
import { CAPABILITIES, LIMITS } from '../../lib/capabilities.js'
import { collectStatus, fetchQrImage, napcatWebUiUrl } from './status-page.mjs'

const MAX_BODY = 256 * 1024

export function createAclToken() {
  return randomBytes(18).toString('base64url')
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { req.destroy(); resolve(null); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * 资源 → 实际判定点的对应表。资源表本身**不是**授权来源（授权永远是权限点，单一事实源），
 * 但页面上必须能看出"这条资源到底接没接到判定上"，否则就是一张装饰表。
 * 没在这张表里的资源 = 仅登记（管理员自己看的清单）。
 */
const WIRED_RESOURCES = {
  'dir:shared': { perm: 'tool.fs.read:shared', note: '受限读工具的共享只读区（uri 相对数据根；改这里就是改实际挂载点）' },
  'svc:ecs': { perm: 'tool.mcp.ecs', note: 'ECS 运维工具' },
  'svc:n8n': { perm: 'tool.mcp.n8n', note: 'n8n 工具' },
  'svc:gh': { perm: 'tool.mcp.gh', note: 'GitHub Actions 工具' },
}

/** 资源 uri 解析成绝对路径（相对路径按数据根解析；没有数据根就按原样判 exists）。 */
function resolveResourcePath(uri, dataRoot) {
  const raw = String(uri ?? '').trim()
  if (raw === '') return ''
  if (isAbsolute(raw)) return raw
  return dataRoot === '' ? raw : join(dataRoot, raw)
}

/** 角色/权限快照（控制台首屏就这一份数据）。 */
export function aclSnapshot(store, { dataRoot = '' } = {}) {
  const policy = store.loadPolicy()
  return {
    file: store.file,
    roles: policy.roles,
    assignments: policy.assignments,
    subjectDenies: policy.subjectDenies,
    defaultRoleByKind: policy.defaultRoleByKind,
    permissions: PERMISSIONS.map((item) => ({ id: item.id, domain: item.domain ?? String(item.id).split('.')[0], kind: item.kind, label: item.label, group: item.group })),
    capabilities: CAPABILITIES.map((item) => ({ id: item.id, kind: item.kind, group: item.group, label: item.label, need: item.need ?? [], gate: item.gate ?? null, entry: item.entry ?? '' })),
    limits: Object.fromEntries(Object.entries(LIMITS).map(([key, spec]) => [key, { direction: spec.direction, default: spec.default, label: spec.label }])),
    // 资源带上"接没接到判定上"和"路径是否存在"，页面才不是一张装饰表
    resources: Object.fromEntries(Object.entries(policy.resources ?? {}).map(([id, row]) => {
      const wired = WIRED_RESOURCES[id] ?? null
      const path = row.kind === 'dir' ? resolveResourcePath(row.uri, dataRoot) : ''
      const grantedRoles = Object.entries(row.grants ?? {})
        .filter(([roleId, actions]) => (actions ?? []).length > 0
          && (wired === null || roleHasPermission(policy, roleId, wired.perm)))
        .map(([roleId]) => roleId)
      return [id, {
        ...row,
        wired: wired?.perm ?? '',
        wiredNote: wired?.note ?? '',
        path,
        exists: path === '' ? null : existsSync(path),
        grantedRoles,
      }]
    })),
    corpora: policy.corpora ?? {},
    corpusBindings: policy.corpusBindings ?? {},
    // 生效快照：哪些会话是按哪套权限面建的（只读展示，D-12：控制台不碰会话）
    sessions: store.listSessions(200),
    audit: store.auditTail(50).map((row) => ({
      at: Number(row.at), actor: row.actor, action: row.action, target: row.target,
      before: safeJson(row.before_json), after: safeJson(row.after_json),
    })),
  }
}

/** 某个角色有没有某个权限点（按基础点比对，范围不限）。 */
function roleHasPermission(policy, roleId, permissionId) {
  const base = String(permissionId).split(':')[0]
  return (policy?.roles?.[roleId]?.permissions ?? []).some((id) => String(id).split(':')[0] === base)
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null } catch { return null }
}

/**
 * 写操作。全部走 store 的写入口（带审计），非法权限点/角色一律拒绝。
 * 返回 `{ ok, status, payload }`。
 */
export function applyAclAction(store, body, { actor = 'console' } = {}) {
  const action = String(body?.action ?? '')
  const list = (value) => (Array.isArray(value) ? value.map(String) : [])
  const bad = (error) => ({ ok: false, status: 400, payload: { ok: false, error } })
  try {
    if (action === 'role-permissions') {
      const role = String(body.role ?? '')
      if (!store.loadPolicy().roles[role]) return bad(`角色不存在：${role}`)
      const perms = list(body.permissions)
      const unknown = perms.filter((id) => !isKnownPermission(id))
      if (unknown.length > 0) return bad(`词表里没有这些权限点：${unknown.join(', ')}`)
      return { ok: true, status: 200, payload: { ok: true, permissions: store.setRolePermissions(role, perms, { actor }) } }
    }
    if (action === 'role-denies') {
      const role = String(body.role ?? '')
      if (!store.loadPolicy().roles[role]) return bad(`角色不存在：${role}`)
      const denies = list(body.denies)
      const unknown = denies.filter((id) => !isKnownPermission(id))
      if (unknown.length > 0) return bad(`词表里没有这些权限点：${unknown.join(', ')}`)
      return { ok: true, status: 200, payload: { ok: true, denies: store.setRoleDenies(role, denies, { actor }) } }
    }
    if (action === 'subject-roles') {
      const subject = String(body.subject ?? '').trim()
      if (!/^(user|group):\S+$/.test(subject)) return bad('主体写法应为 user:<QQ号> 或 group:<群号>')
      const policy = store.loadPolicy()
      const known = new Set(Object.keys(policy.roles ?? {}))
      const wanted = list(body.roles)
      // 认不出的角色直接拒绝，而不是悄悄换算成 guest（那正是"勾了 gq 存成 guest"的来源）
      const unknown = wanted.filter((id) => canonicalRoleId(id, known) === '')
      if (unknown.length > 0) return bad(`角色不存在：${unknown.join(', ')}（可用：${[...known].join(', ')}）`)
      return { ok: true, status: 200, payload: { ok: true, roles: store.setSubjectRoles(subject, wanted, { actor }) } }
    }
    if (action === 'subject-denies') {
      const subject = String(body.subject ?? '').trim()
      if (!/^(user|group):\S+$/.test(subject)) return bad('主体写法应为 user:<QQ号> 或 group:<群号>')
      const denies = list(body.denies)
      const unknown = denies.filter((id) => !isKnownPermission(id))
      if (unknown.length > 0) return bad(`词表里没有这些权限点：${unknown.join(', ')}`)
      return { ok: true, status: 200, payload: { ok: true, denies: store.setSubjectDenies(subject, denies, { actor }) } }
    }
    if (action === 'role-create') {
      const id = String(body.id ?? '').trim()
      if (!/^[a-z][a-z0-9_-]{1,30}$/.test(id)) return bad('角色 id 只能用小写字母/数字/下划线/短横线')
      const policy = store.loadPolicy()
      if (policy.roles[id]) return bad(`角色已存在：${id}`)
      store.db.prepare('INSERT INTO roles(id, name, description, builtin, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run(id, String(body.name ?? id), String(body.description ?? ''), Date.now(), Date.now())
      const clone = body.cloneFrom ? policy.roles[String(body.cloneFrom)]?.permissions ?? [] : []
      store.setRolePermissions(id, clone, { actor })
      store.audit({ actor, action: 'role-create', target: id, after: { cloneFrom: body.cloneFrom ?? '' } })
      return { ok: true, status: 200, payload: { ok: true, id, permissions: clone } }
    }
    if (action === 'role-delete') {
      const id = String(body.id ?? '')
      const builtin = store.db.prepare('SELECT builtin FROM roles WHERE id = ?').get(id)
      if (!builtin) return bad(`角色不存在：${id}`)
      if (Number(builtin.builtin) === 1) return bad('内置角色（admin / legacy / guest）不允许删除')
      store.db.prepare('DELETE FROM roles WHERE id = ?').run(id)
      store.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id)
      store.db.prepare('DELETE FROM role_denies WHERE role_id = ?').run(id)
      store.db.prepare('DELETE FROM subject_roles WHERE role_id = ?').run(id)
      store.audit({ actor, action: 'role-delete', target: id })
      return { ok: true, status: 200, payload: { ok: true } }
    }
    if (action === 'role-limits') {
      const role = String(body.role ?? '')
      if (!store.loadPolicy().roles[role]) return bad(`角色不存在：${role}`)
      const limits = body.limits && typeof body.limits === 'object' ? body.limits : {}
      store.db.prepare('DELETE FROM role_limits WHERE role_id = ?').run(role)
      const ins = store.db.prepare('INSERT INTO role_limits(role_id, key, value) VALUES (?, ?, ?)')
      for (const [key, value] of Object.entries(limits)) {
        if (!LIMITS[key]) continue
        ins.run(role, key, value === null || value === '' ? 'null' : String(Number(value)))
      }
      store.audit({ actor, action: 'set-role-limits', target: role, after: limits })
      return { ok: true, status: 200, payload: { ok: true } }
    }
    if (action === 'resource-upsert') {
      const id = String(body.id ?? '').trim()
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,80}$/.test(id)) return bad('资源 id 只能用字母/数字/._-:/，且不能为空')
      const kind = ['dir', 'service', 'corpus', 'other'].includes(String(body.kind)) ? String(body.kind) : 'dir'
      const row = store.upsertResource({ id, kind, uri: String(body.uri ?? ''), label: String(body.label ?? ''), note: String(body.note ?? '') }, { actor })
      return { ok: true, status: 200, payload: { ok: true, resource: { id: row.id, kind: row.kind, uri: row.uri, label: row.label } } }
    }
    if (action === 'resource-delete') {
      return { ok: true, status: 200, payload: { ok: true, deleted: store.deleteResource(String(body.id ?? ''), { actor }) } }
    }
    if (action === 'resource-grants') {
      const role = String(body.role ?? '')
      const policy = store.loadPolicy()
      if (!policy.roles[role]) return bad(`角色不存在：${role}`)
      const entries = Array.isArray(body.grants) ? body.grants : []
      const unknown = entries.filter((entry) => !policy.resources?.[String(entry?.resourceId ?? '')])
      if (unknown.length > 0) return bad(`资源不存在：${unknown.map((entry) => entry.resourceId).join(', ')}`)
      return { ok: true, status: 200, payload: { ok: true, grants: store.setResourceGrants(role, entries, { actor }) } }
    }
    if (action === 'corpus-upsert') {
      const row = store.upsertCorpus({
        id: String(body.id ?? '').trim(),
        name: String(body.name ?? ''),
        kind: ['files', 'db', 'vector', 'remote'].includes(String(body.kind)) ? String(body.kind) : 'files',
        description: String(body.description ?? ''),
        payloadRef: String(body.payloadRef ?? ''),
        version: Number(body.version) || 1,
        enabled: body.enabled !== false,
      }, { actor })
      return { ok: true, status: 200, payload: { ok: true, corpus: { id: row.id, name: row.name, kind: row.kind, payloadRef: row.payload_ref, enabled: Number(row.enabled) !== 0 } } }
    }
    if (action === 'corpus-delete') {
      return { ok: true, status: 200, payload: { ok: true, deleted: store.deleteCorpus(String(body.id ?? ''), { actor }) } }
    }
    if (action === 'corpus-bindings') {
      const subject = String(body.subject ?? '').trim()
      if (!/^(user|group):\S+$/.test(subject)) return bad('主体写法应为 user:<QQ号> 或 group:<群号>')
      const policy = store.loadPolicy()
      const ids = list(body.corpora)
      const unknown = ids.filter((id) => !policy.corpora?.[id])
      if (unknown.length > 0) return bad(`语料不存在：${unknown.join(', ')}`)
      return { ok: true, status: 200, payload: { ok: true, corpora: store.setCorpusBindings(subject, ids, { actor }) } }
    }
    if (action === 'session-prune') {
      const days = Math.max(0, Number(body.days) || 30)
      const removed = store.pruneSessions(Date.now() - days * 24 * 3600 * 1000)
      store.audit({ actor, action: 'session-prune', target: `${days}d`, after: { removed } })
      return { ok: true, status: 200, payload: { ok: true, removed } }
    }
    return bad(`未知操作：${action || '(空)'}`)
  } catch (error) {
    return { ok: false, status: 500, payload: { ok: false, error: String(error?.message ?? error) } }
  }
}

/**
 * 起服务。`ui` 是页面 HTML 字符串；`store` 可注入（测试用临时库）。
 * 返回 { server, port, url, token, close() }。
 */
export async function startAclConsole({ file, token = createAclToken(), ui = '', port = 0, host = '127.0.0.1', logger = console, corporaRoot = '', dataRoot = '' } = {}) {
  // 语料根：显式给就用，否则按数据根推（<dataRoot>/config/corpora）
  const corpusRoot = corporaRoot !== '' ? corporaRoot : (dataRoot === '' ? '' : join(dataRoot, 'config', 'corpora'))
  const html = ui || (existsSync(new URL('../acl-ui.html', import.meta.url))
    ? readFileSync(new URL('../acl-ui.html', import.meta.url), 'utf8')
    : '<!doctype html><meta charset="utf-8"><h1>权限控制台</h1><p>缺少 control/acl-ui.html</p>')

  // [阶段 0] 状态台页面（同一服务、同一 token；页面本身不需要 token，接口才要）
  const statusHtml = existsSync(new URL('../status-ui.html', import.meta.url))
    ? readFileSync(new URL('../status-ui.html', import.meta.url), 'utf8')
    : '<!doctype html><meta charset="utf-8"><h1>QQ 机器人状态台</h1><p>缺少 control/status-ui.html</p>'

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    const origin = req.headers.origin ?? ''
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return json(res, 403, { ok: false, error: '跨站请求被拒绝' })
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (url.pathname === '/status' || url.pathname === '/status.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(statusHtml)
      return
    }
    const provided = String(url.searchParams.get('token') ?? req.headers['x-acl-token'] ?? '')
    if (provided !== token) return json(res, 401, { ok: false, error: 'token 不对' })

    // ---- [阶段 0] 状态台 / 扫码接口（只读；重启宿主是唯一的写动作，且要 token）----
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, await collectStatus({ dataRoot }))
    }
    if (req.method === 'GET' && url.pathname === '/api/napcat/qr') {
      const qr = await fetchQrImage({ dataRoot })
      return json(res, 200, qr.ok ? { ok: true, ageSeconds: qr.ageSeconds, bytes: qr.bytes } : qr)
    }
    if (req.method === 'GET' && url.pathname === '/api/napcat/qr.png') {
      const qr = await fetchQrImage({ dataRoot })
      if (!qr.ok) return json(res, 404, { ok: false, error: qr.reason })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      return res.end(readFileSync(qr.file))
    }
    if (req.method === 'GET' && url.pathname === '/api/napcat/webui') {
      const target = napcatWebUiUrl({})
      if (url.searchParams.get('format') === 'json') return json(res, 200, { ok: true, url: target })
      res.writeHead(302, { location: target, 'cache-control': 'no-store' })
      return res.end()
    }
    if (req.method === 'POST' && url.pathname === '/api/system/restart-host') {
      const script = process.env.QQ_RESTART_SCRIPT || '/home/zfq/dev/dshbot-ops/scripts/restart-dsh.sh'
      if (!existsSync(script)) return json(res, 500, { ok: false, error: `找不到重启脚本：${script}` })
      const body = (await readBody(req)) ?? {}
      const delay = Math.max(0, Math.min(600, Number(body.delay ?? 15)))
      try {
        spawn('bash', [script, String(delay)], { detached: true, stdio: 'ignore' }).unref()
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return json(res, 200, { ok: true, delay, message: `${delay} 秒后重启宿主（重启前会重新探代理，决定走代理还是直连）` })
    }

    if (!existsSync(file)) return json(res, 500, { ok: false, error: `ACL 库不存在：${file}` })

    const store = openAclStore(file, { create: false })
    try {
      if (req.method === 'GET' && url.pathname === '/api/acl') {
        return json(res, 200, aclSnapshot(store, { dataRoot }))
      }
      if (req.method === 'GET' && url.pathname === '/api/acl/corpus-preview') {
        const subject = String(url.searchParams.get('subject') ?? '').trim()
        if (!/^(user|group):\S+$/.test(subject)) return json(res, 400, { ok: false, error: '要带 subject=user:<QQ号> 或 group:<群号>' })
        const detail = resolveCorpusDetailed({ policy: store.loadPolicy(), subjectId: subject, root: corpusRoot })
        return json(res, 200, {
          ok: true,
          subject,
          bound: detail.bound,
          items: detail.items.map((item) => ({ id: item.id, title: item.title, chars: item.text.length })),
          text: detail.items.map((item) => `【${item.title}】\n${item.text.trim()}`).join('\n\n'),
          skipped: detail.skipped,
        })
      }
      if (req.method === 'GET' && url.pathname === '/api/acl/export') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="acl-export.json"' })
        return res.end(JSON.stringify(store.exportJson(), null, 2))
      }
      if (req.method === 'POST' && url.pathname === '/api/acl') {
        const body = await readBody(req)
        if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON（或超过 256KB）' })
        const result = applyAclAction(store, body, { actor: `console:${req.socket.remoteAddress ?? ''}` })
        return json(res, result.status, result.payload)
      }
      return json(res, 404, { ok: false, error: '没有这个接口' })
    } catch (error) {
      logger?.warn?.(`acl console error: ${error?.message ?? error}`)
      return json(res, 500, { ok: false, error: String(error?.message ?? error) })
    } finally {
      store.close()
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actual = server.address().port
  return {
    server,
    port: actual,
    url: `http://${host}:${actual}/?token=${token}`,
    token,
    file,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
