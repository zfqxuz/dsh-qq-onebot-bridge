/**
 * 控制台统一的路径 / 运行环境解析（唯一入口）。
 *
 * 原则（[本地补丁 阶段 2] 2026-10-12）：
 *   - 镜像里不放任何宿主绝对路径、不放任何个人配置；路径一律三级解析：
 *       ① 环境变量（.env / compose 注入，最终用户可改）
 *       ② 容器内约定目录（/data/... 、/app/...，存在即采用）
 *       ③ 运行用户的 home 相对路径（宿主上直接跑时行为与改造前一致）
 *   - 三级都不写死用户名：home 由 HOME / os.homedir() 在运行时决定。
 *   - 同一份代码在容器（/app 代码、/data 数据）与宿主（仓库目录、~/qqbot）都能跑，
 *     不需要为两种环境分叉逻辑。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 运行用户的 home（容器里是镜像用户，宿主上是登录用户）。 */
export const HOME = process.env.HOME || homedir()

/** 三级解析：显式 env → 第一个存在的候选 → 最后一个候选（兜底值）。 */
export function resolvePath(envName, candidates) {
  const explicit = String(process.env[envName] ?? '').trim()
  if (explicit !== '') return explicit
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return candidate } catch { /* ignore */ }
  }
  return candidates[candidates.length - 1]
}

/** 数据根：QQ 会话、状态、媒体、日志、ACL 库都在这下面。 */
export const dataRoot = resolvePath('QQ_DATA_ROOT', ['/data/qqbot', join(HOME, 'qqbot')])

/** DSH home：profiles / plugins / cordis.patch.yml / 凭据。 */
export const dshHome = resolvePath('DSH_HOME', ['/data/dsh', join(HOME, '.dsh')])

/** 本地插件源码目录（每个插件一个子目录，含 index.js）。 */
export const pluginSources = resolvePath('QQ_PLUGIN_SOURCES', ['/app/plugins', join(HOME, 'dev', 'dsh-plugins')])

/** NapCat 配置目录（webui.json / onebot11.json 等）。 */
export const napcatConfigDir = resolvePath('QQ_NAPCAT_CONFIG_DIR', [
  join(dataRoot, 'napcat-config'),
  join(HOME, 'dshbot', 'qq', 'napcat-config'),
])

/** 宿主重启脚本（控制台"重启宿主"用；容器部署里通常是 compose 脚本）。 */
export const restartScript = resolvePath('QQ_RESTART_SCRIPT', [
  '/app/scripts/restart-dsh.sh',
  join(HOME, 'dev', 'dshbot-ops', 'scripts', 'restart-dsh.sh'),
])

/** 生效的 DSH profile 名。 */
export const profileName = process.env.QQ_PROFILE || 'web'

/** 插件仓库根（插件安装/软链时用；默认取镜像内代码目录的上一级）。 */
export const repoRoot = String(process.env.QQ_REPO_ROOT ?? '').trim()

/**
 * 允许读取私钥指纹的根目录白名单（冒号分隔）。
 * 默认只有运行用户的 home —— 不再写死某个具体用户名。
 */
export function allowedKeyRoots() {
  const raw = String(process.env.QQ_ALLOWED_KEY_ROOTS ?? '').trim()
  const list = (raw !== '' ? raw.split(':') : [HOME]).map((item) => item.trim()).filter(Boolean)
  return list.map((item) => (item.endsWith('/') ? item : `${item}/`))
}

/**
 * dsh 自身的安装目录（读版本号、内置 bundle 用）。
 * 默认从当前 node 可执行文件推：<prefix>/bin/node → <prefix>/lib/node_modules/@deepseek-ai/dsh，
 * 因此宿主（自建 node24）与容器（npm -g 到 /usr/local）都能算对。
 */
export function dshInstallDir() {
  const explicit = String(process.env.QQ_DSH_INSTALL_DIR ?? '').trim()
  if (explicit !== '') return explicit
  const prefix = join(dirname(process.execPath), '..')
  const candidates = [
    join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'), // 同上（保留可读性）
  ]
  for (const candidate of candidates) {
    try { if (existsSync(join(candidate, 'package.json'))) return candidate } catch { /* ignore */ }
  }
  return candidates[0]
}

/** dsh 版本号（读不到返回空串，不抛）。 */
export function dshVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(dshInstallDir(), 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : ''
  } catch { return '' }
}

/** 路径是否在允许的根目录内（用于私钥路径校验）。 */
export function isUnderAllowedRoot(candidate) {
  const path = String(candidate ?? '')
  if (path === '') return true
  return allowedKeyRoots().some((root) => path.startsWith(root))
}
