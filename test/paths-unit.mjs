/**
 * 路径布局测试：旧布局（无 dataRoot）与新布局（有 dataRoot）必须都能算对。
 *
 * 这个文件是"文件系统迁移"的安全带：
 *   - 旧布局路径 = 迁移前线上真实路径，任何一条对不上都说明改坏了兼容性；
 *   - 新布局路径 = SPEC-fs-layout.md §2 的目标树，迁移脚本按它搬运；
 *   - 两个布局的**文件名**必须一一对应（迁移映射表就是它）。
 */
import { join } from 'node:path'
import { CATEGORIES, LAYOUT, legacyPathOf, newPathOf, pathOf, sharedDir, subjectDir, dataRoot, usesNewLayout } from '../lib/paths.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const cwd = '/tmp/paths-test-cwd'
const root = '/tmp/paths-test-root'
const legacy = { cwd }
const modern = { cwd, dataRoot: root }

// ===== 1. 布局开关 =====
check('没配 dataRoot → 旧布局', usesNewLayout(legacy) === false)
check('配了 dataRoot → 新布局', usesNewLayout(modern) === true)
check('数据根 = dataRoot（显式优先）', dataRoot(modern) === root)
check('数据根 = cwd（旧布局回落）', dataRoot(legacy) === cwd)

// ===== 2. 旧布局路径 = 线上真实路径 =====
const LEGACY_EXPECT = {
  sessions: 'qq-sessions.json',
  workspaces: 'qq-workspaces.json',
  runtime: 'qq-runtime.json',
  reminders: 'qq-reminders.json',
  keywords: 'qq-keywords.json',
  broadcast: 'qq-broadcast.json',
  engage: 'qq-engage.json',
  ops: 'qq-ops.json',
  dailyreport: 'qq-dailyreport.json',
  memory: 'qq-memory',
  history: 'qq-history',
  points: 'qq-points',
  stats: 'qq-stats',
  checkin: 'qq-checkin',
  todos: 'qq-todos',
  faces: 'qq-faces',
  images: 'qq-images',
  files: 'qq-files',
  tts: 'qq-tts',
  replies: 'qq-replies',
  exports: 'qq-exports',
  trash: 'qq-trash',
  media: 'qq-media',
  trace: 'qq-trace.jsonl',
  inbox: 'qq-inbox.jsonl',
  debugLog: 'qq-bridge-debug.log',
  actionsLog: 'qq-actions.log',
  badwords: 'qq-badwords.txt',
  inject: 'qq-inject.jsonl',
  guestRoot: 'qq-users/qqguest',
  watchdogIncidents: 'qq/logs/dsh-watchdog-incidents.jsonl',
  watchdogAlert: 'qq/logs/dsh-watchdog-alert-state.json',
}
let legacyOk = true
const legacyWrong = []
for (const [key, expect] of Object.entries(LEGACY_EXPECT)) {
  const got = pathOf(legacy, key)
  if (got !== join(cwd, expect)) { legacyOk = false; legacyWrong.push(`${key}: ${got} != ${join(cwd, expect)}`) }
}
check('旧布局 32 个落点与原线上路径逐一相符', legacyOk, legacyWrong.join(' | '))

// ===== 3. 新布局路径 = 目标树 =====
const NEW_EXPECT = {
  sessions: 'state/sessions.json',
  workspaces: 'state/workspaces.json',
  runtime: 'state/runtime.json',
  reminders: 'state/reminders.json',
  keywords: 'state/keywords.json',
  broadcast: 'state/broadcast.json',
  engage: 'state/engage.json',
  ops: 'state/ops.json',
  dailyreport: 'state/dailyreport.json',
  memory: 'data/memory',
  history: 'data/history',
  points: 'data/points',
  stats: 'data/stats',
  checkin: 'data/checkin',
  todos: 'data/todos',
  faces: 'data/faces',
  images: 'media/images',
  files: 'media/files',
  tts: 'media/voice',
  replies: 'media/replies',
  exports: 'media/exports',
  trash: 'media/trash',
  media: 'media/attachments',
  trace: 'logs/trace.jsonl',
  inbox: 'logs/inbox.jsonl',
  debugLog: 'logs/bridge-debug.log',
  actionsLog: 'logs/actions.log',
  audit: 'logs/audit.jsonl',
  badwords: 'config/badwords.txt',
  inject: 'config/inject.jsonl',
  acl: 'config/acl.db',
  persona: 'config/persona',
  corpora: 'config/corpora',
  guestRoot: 'subjects/guest',
  watchdogIncidents: 'logs/watchdog-incidents.jsonl',
  watchdogAlert: 'logs/watchdog-alert-state.json',
}
let modernOk = true
const modernWrong = []
for (const [key, expect] of Object.entries(NEW_EXPECT)) {
  const got = pathOf(modern, key)
  if (got !== join(root, expect)) { modernOk = false; modernWrong.push(`${key}: ${got} != ${join(root, expect)}`) }
}
check('新布局 36 个落点与目标树逐一相符', modernOk, modernWrong.join(' | '))
check('新布局覆盖了每个分类目录',
  CATEGORIES.every((cat) => Object.values(LAYOUT).some((spec) => spec.dir === cat) || cat === 'subjects' || cat === 'run'))

// ===== 4. 迁移用辅助 =====
check('legacyPathOf 永远算老地方（即便当前已是新布局）',
  legacyPathOf(modern, 'memory') === join(root, 'qq-memory'))
check('newPathOf 永远算新地方（即便当前还是旧布局）',
  newPathOf(root, 'memory') === join(root, 'data', 'memory'))
check('未知落点键直接抛错（不静默落到错路径）', (() => {
  try { pathOf(modern, 'nope'); return false } catch { return true }
})())

// ===== 5. 主体命名空间 =====
check('user: 主体 → subjects/u<qq>', subjectDir(modern, 'user:2493922172') === join(root, 'subjects', 'u2493922172'))
check('group: 主体 → subjects/g<gid>', subjectDir(modern, 'group:176628359') === join(root, 'subjects', 'g176628359'))
check('未知形状的 id 会被转义（不产生路径穿越）',
  subjectDir(modern, 'user:../evil').startsWith(join(root, 'subjects')) && !subjectDir(modern, 'user:../evil').includes('..'))
check('共享区路径固定', sharedDir(modern) === join(root, 'subjects', 'shared'))

// ===== 6. 迁移映射完整性 =====
check('每个落点在两个布局下都有定义（迁移表不缺项）',
  Object.entries(LAYOUT).every(([, spec]) => spec.dir && spec.name && (spec.legacy === null || typeof spec.legacy === 'string')))
check('同一分类下文件名不重复',
  (() => {
    const seen = new Set()
    for (const spec of Object.values(LAYOUT)) {
      const key = `${spec.dir}/${spec.name}`
      if (seen.has(key)) return false
      seen.add(key)
    }
    return true
  })())

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
