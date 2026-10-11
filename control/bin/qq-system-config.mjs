#!/usr/bin/env node
/**
 * 系统配置渲染器（容器每次启动跑一次）—— [本地补丁 阶段 5] 2026-10-12
 *
 * 把控制台里配的「系统配置」渲染成容器里真正生效的文件：
 *   git 身份 + git 凭据助手  → <HOME>/.gitconfig
 *   gh 凭据                  → <GH_CONFIG_DIR>/hosts.yml（0600）
 *   工作区                   → <数据根>/state/workspace.effective（entrypoint 读它决定 cd 到哪）
 *
 * 铁律：
 *   - **只补缺，不覆盖**：git 键已存在、gh 该 host 已有 token → 一律保留；
 *     唯一例外是 system.json 里明确写了新 token（那是用户在控制台刚输入的意图）。
 *   - **外部挂载优先**：GIT_CONFIG_GLOBAL / GH_CONFIG_DIR 由环境显式指定时跳过（那说明是
 *     开发机挂了宿主配置），只报告不动手。
 *   - 报告写 <数据根>/state/system-config.json 给控制台看，**绝不含 token 原文**。
 *   - 任何失败都只打印日志、退出码 0：渲染不该拖垮启动。
 *
 * 用法：node qq-system-config.mjs [--dry-run] [--quiet] [--data-root DIR] [--config FILE] [--home DIR]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dataRoot as dataRootResolved } from '../lib/paths.mjs'
import { applySystemConfig } from '../lib/system-config-apply.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const DRY = has('--dry-run')
const QUIET = has('--quiet')
const DATA_ROOT = valueOf('--data-root', process.env.QQ_DATA_ROOT || dataRootResolved)
const CONFIG_FILE = valueOf('--config', join(DATA_ROOT, 'config', 'system.json'))
const HOME = valueOf('--home', process.env.HOME || homedir())
const STATE_DIR = join(DATA_ROOT, 'state')
const REPORT_FILE = join(STATE_DIR, 'system-config.json')
const EFFECTIVE_FILE = join(STATE_DIR, 'workspace.effective')

const log = (...a) => { if (!QUIET) console.log('[syscfg]', ...a) }

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

try {
  const config = readJson(CONFIG_FILE, null)
  const exists = existsSync(CONFIG_FILE)

  // 外部挂载优先：显式给了这两个环境变量 = 开发机挂了宿主配置，不动手
  const externalGit = String(process.env.GIT_CONFIG_GLOBAL ?? '').trim() !== ''
  const externalGh = String(process.env.GH_CONFIG_DIR ?? '').trim() !== ''
  const gitConfigFile = process.env.GIT_CONFIG_GLOBAL || join(HOME, '.gitconfig')
  const ghDir = process.env.GH_CONFIG_DIR || join(HOME, '.config', 'gh')

  const report = applySystemConfig({
    config: config ?? {},
    home: HOME,
    gitConfigFile,
    ghDir,
    workspaceActual: String(process.env.QQ_WORKSPACE ?? ''),
    externalGit,
    externalGh,
    dryRun: DRY,
    source: 'boot',
  })
  report.configFile = CONFIG_FILE
  report.configExists = exists

  if (!DRY) {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`)
    // entrypoint 只认这一行：本次启动实际采用的工作区（必须真实存在才写）
    const eff = report.workspace.effective
    if (eff !== '' && existsSync(eff)) writeFileSync(EFFECTIVE_FILE, `${eff}\n`)
  }

  if (!exists) {
    log(`未配置（${CONFIG_FILE} 不存在）→ git/gh/工作区全部保持现状。要到控制台「系统配置」页去配。`)
  } else {
    log(`git: ${report.git.action} — ${report.git.detail}`)
    log(`git 凭据助手: ${report.credential?.action} — ${report.credential?.detail}`)
    log(`gh: ${report.gh.action} — ${report.gh.detail}`)
    log(`工作区: 挂载=${report.workspace.actual || '-'} 配置=${report.workspace.desired || '-'} 采用=${report.workspace.effective || '-'}${report.workspace.pending ? '（待重启生效）' : ''}`)
    if (report.workspace.reason) log(`  ${report.workspace.reason}`)
  }
  log(`报告：${REPORT_FILE}`)
} catch (error) {
  // 渲染失败不影响启动：打印原因，退出码仍是 0
  console.error('[syscfg] 渲染失败（不影响启动）：', String(error?.stack ?? error).slice(0, 500))
}
process.exit(0)
