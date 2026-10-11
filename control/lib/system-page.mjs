/**
 * 系统页的数据层（阶段 0 之三，2026-10-12）
 *
 * 用户要求：系统相关配置（状态监听、重启策略等）也要能在控制台改，并且要分清
 *   「改了立即生效 / 只需重启 watchdog / 需要重启宿主」，危险操作要二次确认。
 *
 * 事实依据：
 *   - 看门狗与代理回落的开关都来自 ~/.config/dsh-bot/dsh.env（systemd EnvironmentFile，
 *     由 ops 的 install-watchdog.sh 渲染），改完只需 `systemctl --user restart dsh-watchdog`；
 *   - 宿主（dsh-web）是 transient 单元，重启它会短暂断 QQ；
 *   - 控制台自己（qq-acl-console）重启只断自己 1~2 秒；
 *   - NapCat 是 docker 容器 napcat，重启它 QQ 会离线更久，可能要求重新扫码（风险最高）。
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataRoot } from './paths.mjs'

const DSH_ENV = process.env.QQ_DSH_ENV || join(homedir(), '.config/dsh-bot/dsh.env')

/** 参数目录：scope 决定"改完要重启谁"，risk 决定页面上怎么提示。 */
export const PARAMS = [
  { key: 'WATCHDOG_INTERVAL', label: '看门狗探测间隔（秒）', type: 'number', min: 5, max: 300, def: 15, scope: 'watchdog' },
  { key: 'WATCHDOG_FAIL_THRESHOLD', label: '连续失败多少次算掉线', type: 'number', min: 1, max: 10, def: 2, scope: 'watchdog' },
  { key: 'WATCHDOG_MAX_PER_HOUR', label: '每小时最多重启几次', type: 'number', min: 0, max: 20, def: 4, scope: 'watchdog' },
  { key: 'WATCHDOG_SETTLE_ROUNDS', label: '重启后等待就绪的轮数', type: 'number', min: 5, max: 600, def: 45, scope: 'watchdog' },
  { key: 'WATCHDOG_WEBHOOK', label: '事故外发 Webhook（可空）', type: 'text', def: '', scope: 'watchdog' },
  { key: 'HTTP_PROXY', label: 'HTTP 代理（可空）', type: 'text', def: '', scope: 'watchdog' },
  { key: 'HTTPS_PROXY', label: 'HTTPS 代理（可空）', type: 'text', def: '', scope: 'watchdog' },
  { key: 'PROXY_PROBE_URL', label: '代理探活目标 URL', type: 'text', def: 'https://api.deepseek.com', scope: 'watchdog' },
  { key: 'PROXY_PROBE_TIMEOUT', label: '探活超时（秒）', type: 'number', min: 1, max: 60, def: 4, scope: 'watchdog' },
  { key: 'WATCHDOG_PROXY_PROBE_EVERY', label: '每几轮探一次代理', type: 'number', min: 1, max: 60, def: 4, scope: 'watchdog' },
  { key: 'WATCHDOG_PROXY_SWITCH_AFTER', label: '连续几次不可用就切直连', type: 'number', min: 1, max: 10, def: 3, scope: 'watchdog' },
  { key: 'WATCHDOG_PROXY_DRY_RUN', label: '代理切换干跑（只记不重启）', type: 'bool', def: '0', scope: 'watchdog' },
]

const SERVICES = [
  { id: 'dsh-web', kind: 'unit', name: 'DSH 宿主（QQ 桥接在这里面）', risk: '重启会让 QQ 掉线约 7~15 秒', riskLevel: 'high' },
  { id: 'dsh-watchdog', kind: 'unit', name: '看门狗', risk: '秒级重启，不影响 QQ', riskLevel: 'low' },
  { id: 'qq-acl-console', kind: 'unit', name: '控制台（本页）', risk: '正在看的页面会断 1~2 秒', riskLevel: 'low' },
  { id: 'napcat', kind: 'docker', name: 'NapCat（QQ 协议端）', risk: 'QQ 离线更久，可能需要重新扫码登录', riskLevel: 'highest' },
]

function run(command, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error?.code ?? 0 })
    })
  })
}

function readEnvFile() {
  if (!existsSync(DSH_ENV)) return { exists: false, values: {}, text: '' }
  const text = readFileSync(DSH_ENV, 'utf8')
  const values = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) values[m[1]] = m[2]
  }
  return { exists: true, values, text }
}

/** 读系统页：参数（含当前值/范围/生效方式）+ 服务状态 + 最近日志。 */
export async function readSystemPage() {
  const env = readEnvFile()
  const params = PARAMS.map((p) => {
    const raw = env.values[p.key]
    const value = raw === undefined ? String(p.def ?? '') : raw
    const missing = raw === undefined
    return {
      key: p.key, label: p.label, type: p.type, value, def: String(p.def ?? ''),
      min: p.min ?? null, max: p.max ?? null, scope: p.scope, missing,
      restart: '重启 dsh-watchdog 后生效（不影响 QQ）',
    }
  })

  const services = []
  for (const s of SERVICES) {
    if (s.kind === 'unit') {
      const active = (await run('systemctl', ['--user', 'is-active', s.id], 4000)).stdout.trim()
      const props = (await run('systemctl', ['--user', 'show', s.id, '-p', 'MainPID', '-p', 'ActiveEnterTimestamp', '-p', 'NRestarts'], 4000)).stdout
      const pick = (k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(props) ?? [])[1] ?? ''
      services.push({ ...s, state: active || 'unknown', pid: pick('MainPID'), since: pick('ActiveEnterTimestamp'), restarts: pick('NRestarts') })
    } else {
      const inspect = (await run('docker', ['inspect', s.id, '--format', '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}'], 5000)).stdout.trim()
      const [state = 'missing', since = '', restarts = ''] = inspect.split('|')
      services.push({ ...s, state, pid: '', since, restarts })
    }
  }

  const tail = (file, n) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n) } catch { return [] } }
  const incidents = tail(join(dataRoot, 'logs', 'dsh-watchdog-incidents.jsonl'), 8).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const proxy = (() => { try { return JSON.parse(readFileSync(join(dataRoot, 'state', 'proxy.json'), 'utf8')) } catch { return null } })()

  return {
    ok: true,
    envFile: DSH_ENV,
    envExists: env.exists,
    params,
    services,
    proxy,
    logs: {
      watchdog: tail(join(dataRoot, 'logs', 'dsh-watchdog.log'), 60),
      restart: tail(join(dataRoot, 'logs', 'dsh-restart.log'), 20),
      incidents,
    },
  }
}

/** 写系统参数：范围校验 → 备份 → 只在 dsh.env 里 upsert（不改别的行）。 */
export function saveSystemConfig({ values = {} } = {}) {
  if (!existsSync(DSH_ENV)) return { ok: false, error: `找不到 ${DSH_ENV}` }
  const text = readFileSync(DSH_ENV, 'utf8')
  const lines = text.split('\n')
  const changed = []
  const rejected = []
  for (const [key, rawValue] of Object.entries(values)) {
    const meta = PARAMS.find((p) => p.key === key)
    if (!meta) { rejected.push(`${key}(不在白名单)`); continue }
    const value = String(rawValue ?? '').trim()
    if (meta.type === 'number') {
      const num = Number(value)
      if (!Number.isFinite(num) || num < meta.min || num > meta.max) { rejected.push(`${key}(需 ${meta.min}~${meta.max})`); continue }
    }
    if (meta.type === 'bool' && !['0', '1'].includes(value)) { rejected.push(`${key}(只能是 0 或 1)`); continue }
    const re = new RegExp(`^${key}=`)
    const idx = lines.findIndex((l) => re.test(l))
    if (idx >= 0) {
      if (lines[idx] === `${key}=${value}`) continue
      lines[idx] = `${key}=${value}`
    } else {
      lines.push(`${key}=${value}`)
    }
    changed.push(key)
  }
  if (changed.length === 0) return { ok: false, error: `没有可写项（${rejected.join(', ') || '值没变化'}）` }
  const backup = `${DSH_ENV}.bak-console-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(DSH_ENV, backup)
  writeFileSync(DSH_ENV, lines.join('\n'))
  return { ok: true, changed, rejected, backup, note: '已写入 dsh.env；点「重启看门狗」后生效（不影响 QQ）。宿主相关参数需重启宿主。' }
}

/** 服务控制：只允许白名单单元/容器与白名单动作；调用方必须先验证 sudo。 */
export async function serviceAction({ id, action }) {
  const svc = SERVICES.find((s) => s.id === id)
  if (!svc) return { ok: false, error: '不在白名单里的服务' }
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: `不支持的动作：${action}` }
  if (svc.kind === 'docker' && action !== 'restart') return { ok: false, error: 'NapCat 只允许重启' }
  const r = svc.kind === 'unit'
    ? await run('systemctl', ['--user', action, svc.id], 20000)
    : await run('docker', ['restart', svc.id], 60000)
  return { ok: r.ok, output: `${r.stdout}${r.stderr}`.trim().slice(0, 500), service: svc.id, action, risk: svc.risk }
}
