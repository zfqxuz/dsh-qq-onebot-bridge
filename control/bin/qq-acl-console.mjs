#!/usr/bin/env node
/**
 * 权限控制台（本地可视化，只做权限管理；不碰 QQ 会话）。
 *
 *   node control/bin/qq-acl-console.mjs [--port 8798] [--file <acl.db>] [--open]
 *
 * - 只绑 127.0.0.1；URL 里带 token（token 存在 <数据根>/state/acl-console.json，重启后地址不变）
 * - 页面：角色与权限矩阵（allow + deny）/ 主体分配 / 能力视角 / 审计
 * - 数据源就是 lib/acl-store.js 那个库；页面上的改动立刻落库（带审计），
 *   桥接最多 5 秒后（权限快照缓存）读到新策略
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createAclToken, startAclConsole } from '../lib/acl-console.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const dataRoot = argOf('data-root', process.env.QQ_DATA_ROOT || '/home/zfq/qqbot')
const stateFile = join(dataRoot, 'state', 'acl-console.json')
const dbFile = argOf('file', join(dataRoot, 'config', 'acl.db'))
const port = Number(argOf('port', '0')) || 8798

if (!existsSync(dbFile)) {
  console.error(`ACL 库不存在：${dbFile}\n先初始化：npm run acl -- init --file ${dbFile}`)
  process.exit(2)
}

let state = { token: '', port }
try { state = { ...state, ...JSON.parse(readFileSync(stateFile, 'utf8')) } } catch { /* 首次运行 */ }
state.token = state.token || createAclToken()
state.port = port
mkdirSync(dirname(stateFile), { recursive: true })
writeFileSync(stateFile, JSON.stringify(state, null, 2))

const console_ = await startAclConsole({ file: dbFile, token: state.token, port })
console.log('权限控制台已启动：')
console.log(`  ${console_.url}`)
console.log(`  库文件：${dbFile}`)
console.log('  提示：只绑 127.0.0.1，URL 里的 token 就是凭证，别外传。')

if (args.includes('--open')) {
  const opener = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'cmd' : 'xdg-open')
  try { spawn(opener, process.platform === 'win32' ? ['/c', 'start', '', console_.url] : [console_.url], { detached: true, stdio: 'ignore' }).unref() } catch { /* 忽略 */ }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await console_.close(); process.exit(0) })
}
