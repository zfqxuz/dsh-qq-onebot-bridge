/**
 * 控制台的登录与会话（[阶段 1 返工] 2026-10-12）
 *
 * 用户要求：别再用"URL 里带 token"这种没人记得住的东西，搞正经的用户登录。
 *
 * 设计（本地单机、只绑 127.0.0.1，够用且不引入依赖）：
 *   - 用户表：<dataRoot>/state/console-users.json，密码用 scrypt + 随机 salt 存哈希，绝不存明文；
 *   - 首次使用：没有任何用户时，登录页显示"设置管理员密码"（只接受回环来源）；
 *   - 会话：/api/login 成功后下发 HttpOnly + SameSite=Strict 的 cookie，内存保存（进程重启需重新登录）；
 *   - 危险操作：/api/reauth 校验密码后给会话开 5 分钟 sudo 窗口，重启宿主/NapCat 这类操作要求它在有效期内；
 *   - 输入校验：用户名/密码长度上限，登录失败按来源 IP 限速（防本机暴力试，主要防误伤自己）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
export const SUDO_TTL_MS = 5 * 60 * 1000
export const COOKIE_NAME = 'qqconsole_session'

export function usersFile(dataRoot) {
  return join(dataRoot, 'state', 'console-users.json')
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex')
  return { algo: 'scrypt', salt, hash, ...SCRYPT }
}

export function verifyPassword(record, password) {
  if (!record?.salt || !record?.hash) return false
  try {
    const expected = Buffer.from(record.hash, 'hex')
    const actual = scryptSync(String(password), record.salt, expected.length, { N: record.N ?? SCRYPT.N, r: record.r ?? SCRYPT.r, p: record.p ?? SCRYPT.p })
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch { return false }
}

/** 用户存储：读/写 + 首次初始化的判断。 */
export function openUserStore(dataRoot) {
  const file = usersFile(dataRoot)
  const load = () => {
    const data = readJsonSafe(file)
    return data && typeof data.users === 'object' ? data : { version: 1, users: {} }
  }
  const save = (data) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 })
  }
  return {
    file,
    hasUsers: () => Object.keys(load().users).length > 0,
    names: () => Object.keys(load().users),
    get: (name) => load().users[String(name)] ?? null,
    /** 首次设置管理员；已有用户时必须带 existingPassword 校验。 */
    setPassword(name, password, { requireExisting = false } = {}) {
      const user = String(name ?? '').trim()
      if (!/^[\w.-]{2,32}$/.test(user)) return { ok: false, error: '用户名要是 2~32 位字母数字或 . _ -' }
      if (String(password ?? '').length < 8) return { ok: false, error: '密码至少 8 位' }
      if (String(password ?? '').length > 200) return { ok: false, error: '密码太长' }
      const data = load()
      if (requireExisting && Object.keys(data.users).length === 0) return { ok: false, error: '还没有用户，先做首次设置' }
      data.users[user] = { ...hashPassword(password), updatedAt: Date.now() }
      save(data)
      return { ok: true, user }
    },
    verify(name, password) {
      return verifyPassword(this.get(name), password)
    },
  }
}

/** 会话表（内存）：sid → { user, createdAt, expiresAt, sudoUntil }。 */
export function createSessionStore() {
  const sessions = new Map()
  const prune = () => { const now = Date.now(); for (const [sid, s] of sessions) if (s.expiresAt < now) sessions.delete(sid) }
  return {
    create(user) {
      prune()
      const sid = randomBytes(32).toString('hex')
      sessions.set(sid, { user, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, sudoUntil: 0 })
      return sid
    },
    get(sid) { prune(); return sid ? sessions.get(sid) ?? null : null },
    destroy(sid) { sessions.delete(sid) },
    grantSudo(sid) { const s = sessions.get(sid); if (s) s.sudoUntil = Date.now() + SUDO_TTL_MS; return s ?? null },
    hasSudo(sid) { const s = this.get(sid); return Boolean(s && s.sudoUntil > Date.now()) },
    count() { prune(); return sessions.size },
  }
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function sessionCookie(sid, { maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000), clear = false } = {}) {
  const base = `${COOKIE_NAME}=${clear ? '' : sid}; Path=/; HttpOnly; SameSite=Strict`
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${maxAgeSeconds}`
}

/** 登录限速：同一来源连续失败 5 次锁 60 秒（本地单机，够用）。 */
export function createLoginThrottle({ maxFailures = 5, lockMs = 60_000 } = {}) {
  const state = new Map()
  return {
    check(key) {
      const s = state.get(key)
      if (s && s.lockedUntil > Date.now()) return { ok: false, retryAfterSeconds: Math.ceil((s.lockedUntil - Date.now()) / 1000) }
      return { ok: true }
    },
    fail(key) {
      const s = state.get(key) ?? { failures: 0, lockedUntil: 0 }
      s.failures += 1
      if (s.failures >= maxFailures) { s.lockedUntil = Date.now() + lockMs; s.failures = 0 }
      state.set(key, s)
    },
    ok(key) { state.delete(key) },
  }
}
