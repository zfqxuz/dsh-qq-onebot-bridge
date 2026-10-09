/**
 * 语料库解析层（SPEC-rbac-console.md §6）。
 *
 * 分工：
 *   - **数据模型**只有"资产"这一层：`corpora(id, name, kind, payload_ref, enabled)`；
 *   - `kind` 先只实现 `files`（一个目录里的若干文本文件），以后加 `db` / `vector` / `remote`
 *     都只是多一个 resolver 分支，调用方不动；
 *   - **绑定** = `corpus_bindings(subject → corpus)`（选择用哪些）；
 *   - **白名单** = 权限点 `persona.corpus:<id>`（能不用哪些）。两者都要过 ——
 *     绑了但没权限 = 不给（fail-closed，并记进 skipped 让人看得见）。
 *
 * 硬要求：**绝不让语料把会话搞崩**。任何异常（目录不存在、编码错、太大）都吞成"这条语料跳过"。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { grantsFor } from './acl.js'

const TEXT_EXT = /\.(md|txt|text|markdown)$/i

const DEFAULT_MAX_FILE = 16 * 1024
const DEFAULT_MAX_TOTAL = 64 * 1024

/**
 * 权限点是否放行某条语料：allow 里有 `persona.corpus:<id>` / `persona.corpus:*`，
 * 且 deny 里没有。返回 '' 表示放行，否则返回"为什么不行"（控制台与日志要能看见原因）。
 */
function corpusDenyReason(policy, subjectId, id) {
  const { allow, deny } = grantsFor(policy, subjectId)
  const hit = (list) => list.some((item) => item === `persona.corpus:${id}` || item === 'persona.corpus:*' || item === 'persona.corpus')
  if (hit(deny)) return `被 deny 覆盖（persona.corpus:${id}）`
  if (!hit(allow)) return `角色白名单里没有 persona.corpus:${id}`
  return ''
}

/** 这条语料该用哪些目录：`payloadRef` 相对路径按 `root` 解析。 */
export function corpusPath(payloadRef, root) {
  const raw = String(payloadRef ?? '').trim()
  if (raw === '') return ''
  return isAbsolute(raw) ? raw : join(String(root ?? ''), raw)
}

function readFiles(dir, { maxFile }) {
  const out = []
  const names = readdirSync(dir).filter((name) => TEXT_EXT.test(name) && !name.startsWith('.')).sort()
  for (const name of names) {
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      const text = readFileSync(file, 'utf8').slice(0, maxFile)
      if (text.trim() !== '') out.push({ title: name, text })
    } catch {
      // 单个文件读不了就跳过，不影响别的
    }
  }
  return out
}

/**
 * 解析某主体在当前会话下生效的语料（详细版，控制台预览用）。
 *
 * @returns {{ items: {id,title,text}[], skipped: {id,reason}[], bound: string[] }}
 */
export function resolveCorpusDetailed({ policy, subjectId, corpora = null, bindings = null, root = '', maxFile = DEFAULT_MAX_FILE, maxTotal = DEFAULT_MAX_TOTAL } = {}) {
  const items = []
  const skipped = []
  const all = corpora ?? policy?.corpora ?? {}
  const bound = [...(bindings ?? policy?.corpusBindings?.[String(subjectId ?? '')] ?? [])]
  let total = 0
  for (const id of bound) {
    try {
      const meta = all[id]
      if (!meta) { skipped.push({ id, reason: '库里没有这条语料' }); continue }
      if (meta.enabled === false) { skipped.push({ id, reason: '已停用' }); continue }
      if (String(meta.kind ?? 'files') !== 'files') { skipped.push({ id, reason: `kind=${meta.kind} 暂时没有 resolver` }); continue }
      const denyReason = corpusDenyReason(policy, subjectId, id)
      if (denyReason !== '') { skipped.push({ id, reason: denyReason }); continue }
      const path = corpusPath(meta.payloadRef, root)
      if (path === '' || !existsSync(path)) { skipped.push({ id, reason: '目录不存在：' + (path || '(空 payload_ref)') }); continue }
      const files = readFiles(path, { maxFile })
      if (files.length === 0) { skipped.push({ id, reason: '目录里没有可读的 .md/.txt' }); continue }
      for (const file of files) {
        if (total >= maxTotal) break
        const room = maxTotal - total
        const text = file.text.slice(0, room)
        total += Buffer.byteLength(text, 'utf8')
        items.push({ id, title: `${meta.name || id} / ${file.title}`, text })
      }
    } catch (error) {
      skipped.push({ id, reason: String(error?.message ?? error) })
    }
  }
  return { items, skipped, bound }
}

/** SPEC 约定的返回形状：`[{ id, title, text }]`，出错返回空数组。 */
export function resolveCorpus(options = {}) {
  try {
    return resolveCorpusDetailed(options).items
  } catch {
    return []
  }
}

/** 拼成一段可注入的系统提示文本（没内容返回 ''，调用方就不用判了）。 */
export function corpusSectionText(items) {
  if (!Array.isArray(items) || items.length === 0) return ''
  const parts = items.map((item) => `【${item.title}】\n${item.text.trim()}`)
  return '以下是本次会话可用的语料（只读，作为背景知识；与用户要求冲突时以用户为准）：\n\n' + parts.join('\n\n')
}
