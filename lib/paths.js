/**
 * 统一路径派生：数据根（dataRoot）→ 分类目录（布局说明见仓库 docs/ 的 fs-layout 规格）。
 *
 * 兼容策略（重要）：
 *   - **没配 `dataRoot`** → 全部走"旧布局"（文件直接落在 `config.cwd` 下，名字保持 `qq-*`）。
 *     现有部署与全部单测都是这种状态，行为一字不变。
 *   - **配了 `dataRoot`** → 走新布局：`<dataRoot>/{config,state,data,media,subjects,logs,run}`。
 *     迁移就是把数据搬过去 + 在 profile 里加一个 dataRoot，代码不用再分叉。
 *
 * 为什么这样做：桥接里有 30 多个 `join(config.cwd, 'qq-xxx')` 的落点，逐个改成"新路径"
 * 会让"旧布局能不能跑"变成一堆 if。收成一个开关，迁移与回滚都只是改一行配置。
 *
 * 这里只做路径计算，不碰磁盘（测试与迁移脚本都要能用）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 数据根：显式 dataRoot 优先，否则退回 cwd（= 旧布局）。 */
export function dataRoot(config) {
  const explicit = String(config?.dataRoot ?? '').trim()
  if (explicit !== '') return explicit
  return String(config?.cwd ?? '') || process.cwd()
}

/** 是否启用新布局（配了 dataRoot 就是新布局）。 */
export function usesNewLayout(config) {
  return String(config?.dataRoot ?? '').trim() !== ''
}

/**
 * 落点表：逻辑键 → { legacy 旧名（放 cwd 下）, dir 新布局分类, name 新布局文件名 }。
 * `legacy` 为 null 表示"只在旧布局里以目录形式存在于 qq/ 下"，见下方注释。
 */
export const LAYOUT = {
  // 运行状态（要备份）
  sessions: { legacy: 'qq-sessions.json', dir: 'state', name: 'sessions.json' },
  workspaces: { legacy: 'qq-workspaces.json', dir: 'state', name: 'workspaces.json' },
  runtime: { legacy: 'qq-runtime.json', dir: 'state', name: 'runtime.json' },
  reminders: { legacy: 'qq-reminders.json', dir: 'state', name: 'reminders.json' },
  keywords: { legacy: 'qq-keywords.json', dir: 'state', name: 'keywords.json' },
  broadcast: { legacy: 'qq-broadcast.json', dir: 'state', name: 'broadcast.json' },
  engage: { legacy: 'qq-engage.json', dir: 'state', name: 'engage.json' },
  ops: { legacy: 'qq-ops.json', dir: 'state', name: 'ops.json' },
  dailyreport: { legacy: 'qq-dailyreport.json', dir: 'state', name: 'dailyreport.json' },
  control: { legacy: 'qq-control.json', dir: 'state', name: 'control.json' },

  // 业务数据（要备份）
  memory: { legacy: 'qq-memory', dir: 'data', name: 'memory' },
  history: { legacy: 'qq-history', dir: 'data', name: 'history' },
  points: { legacy: 'qq-points', dir: 'data', name: 'points' },
  stats: { legacy: 'qq-stats', dir: 'data', name: 'stats' },
  checkin: { legacy: 'qq-checkin', dir: 'data', name: 'checkin' },
  todos: { legacy: 'qq-todos', dir: 'data', name: 'todos' },
  faces: { legacy: 'qq-faces', dir: 'data', name: 'faces' },

  // 媒体（可清理）
  images: { legacy: 'qq-images', dir: 'media', name: 'images' },
  files: { legacy: 'qq-files', dir: 'media', name: 'files' },
  tts: { legacy: 'qq-tts', dir: 'media', name: 'voice' },
  replies: { legacy: 'qq-replies', dir: 'media', name: 'replies' },
  exports: { legacy: 'qq-exports', dir: 'media', name: 'exports' },
  trash: { legacy: 'qq-trash', dir: 'media', name: 'trash' },
  media: { legacy: 'qq-media', dir: 'media', name: 'attachments' },

  // 遥测（可轮转）
  trace: { legacy: 'qq-trace.jsonl', dir: 'logs', name: 'trace.jsonl' },
  inbox: { legacy: 'qq-inbox.jsonl', dir: 'logs', name: 'inbox.jsonl' },
  debugLog: { legacy: 'qq-bridge-debug.log', dir: 'logs', name: 'bridge-debug.log' },
  actionsLog: { legacy: 'qq-actions.log', dir: 'logs', name: 'actions.log' },
  audit: { legacy: null, dir: 'logs', name: 'audit.jsonl' },
  watchdogIncidents: { legacy: join('qq', 'logs', 'dsh-watchdog-incidents.jsonl'), dir: 'logs', name: 'watchdog-incidents.jsonl' },
  watchdogAlert: { legacy: join('qq', 'logs', 'dsh-watchdog-alert-state.json'), dir: 'logs', name: 'watchdog-alert-state.json' },

  // 配置（要备份）
  badwords: { legacy: 'qq-badwords.txt', dir: 'config', name: 'badwords.txt' },
  inject: { legacy: 'qq-inject.jsonl', dir: 'config', name: 'inject.jsonl' },
  acl: { legacy: null, dir: 'config', name: 'acl.db' },
  persona: { legacy: join('qq', 'config', 'persona'), dir: 'config', name: 'persona' },
  corpora: { legacy: null, dir: 'config', name: 'corpora' },

  // 访客可读写根（新布局里仍在 subjects/ 下；按主体细分见 P1b 隔离修复）
  guestRoot: { legacy: join('qq-users', 'qqguest'), dir: 'subjects', name: 'guest' },
}

/** 逻辑键 → 绝对路径（自动按当前布局）。键不存在直接抛，避免静默落到错误路径。 */
export function pathOf(config, key) {
  const spec = LAYOUT[key]
  if (!spec) throw new Error(`paths.js: 未知落点键 ${key}`)
  const root = dataRoot(config)
  if (!usesNewLayout(config)) {
    return join(root, spec.legacy ?? join(spec.dir, spec.name))
  }
  return join(root, spec.dir, spec.name)
}

/** 旧布局下的路径（迁移脚本要用：无论当前配置如何，都能算出"老地方"）。 */
export function legacyPathOf(config, key) {
  const spec = LAYOUT[key]
  if (!spec) throw new Error(`paths.js: 未知落点键 ${key}`)
  return join(dataRoot(config), spec.legacy ?? join(spec.dir, spec.name))
}

/** 新布局下的路径（迁移脚本要用：无论当前配置如何，都能算出"新地方"）。 */
export function newPathOf(root, key) {
  const spec = LAYOUT[key]
  if (!spec) throw new Error(`paths.js: 未知落点键 ${key}`)
  return join(root, spec.dir, spec.name)
}

/** 数据区顶层分类目录（迁移建骨架、备份脚本用）。 */
export const CATEGORIES = ['config', 'state', 'data', 'media', 'subjects', 'logs', 'run']

/** 主体命名空间目录：`user:10001` → `<root>/subjects/u10001`。 */
export function subjectDir(config, subjectId) {
  const id = String(subjectId ?? '').trim()
  // 只留下安全字符，并把 `.`/`..` 这类路径片段压平：主体 id 来自配置与 QQ 事件，
  // 不能让它把路径带出 subjects/（例如 `user:../evil`）。
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+/, '_')
  const name = safe.startsWith('user_') ? `u${safe.slice(5)}`
    : safe.startsWith('group_') ? `g${safe.slice(6)}`
      : safe
  return join(dataRoot(config), 'subjects', name)
}

/** 共享只读区。 */
export function sharedDir(config) {
  return join(dataRoot(config), 'subjects', 'shared')
}

/** 主用户的 home（DSH 相关路径用，跟数据根无关）。 */
export function homeDir() {
  return process.env.HOME || homedir()
}

/**
 * 本地插件（不是 npm 包，直接躺在一个目录里）的位置候选。
 *
 * 为什么需要：桥接里对 `dsh-tool-fs-jailed` 用的是相对 import（`../../plugins/...`），
 * 一旦源码目录搬家（我们从 `dshbot/qq/qq-onebot-bridge` 挪到了 `dev/dsh-qq-onebot-bridge`），
 * 相对路径就悄悄失效了 —— 表现是 guest 会话"没有任何读工具"，而且只在 debug 日志里留一行。
 * 现在改成"按候选顺序找第一个存在的"，并且把"用了哪份 / 一份都没找到"写进日志。
 */
export function localPluginCandidates(name, { repoRoot = '', cwd = '', explicit = '' } = {}) {
  const list = []
  if (explicit) list.push(explicit)
  if (repoRoot) {
    list.push(join(repoRoot, 'plugins', name, 'index.js'))          // 上游约定：仓库内 plugins/
    list.push(join(repoRoot, '..', 'dsh-plugins', name, 'index.js')) // 本机约定：dev/dsh-plugins/
    list.push(join(repoRoot, '..', 'dev', 'dsh-plugins', name, 'index.js'))
  }
  if (cwd) {
    list.push(join(cwd, 'qq', 'plugins', name, 'index.js'))         // 历史位置（工作区副本）
    list.push(join(cwd, 'plugins', name, 'index.js'))
  }
  return [...new Set(list)]
}

/** 候选里第一个真实存在的文件；都没有返回 ''（调用方 fail-closed 并记日志）。 */
export function pickExistingFile(candidates, exists = existsSync) {
  for (const file of candidates ?? []) {
    try { if (file && exists(file)) return file } catch { /* ignore */ }
  }
  return ''
}

/** 主体命名空间的根（新布局 <dataRoot>/subjects；旧布局 cwd/subjects）。 */
export function subjectRoot(config) {
  if (usesNewLayout(config)) return join(dataRoot(config), 'subjects')
  return join(dataRoot(config), 'subjects')
}
