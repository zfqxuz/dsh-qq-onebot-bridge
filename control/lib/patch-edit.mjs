/**
 * 逐行编辑 DSH profile patch（cordis.patch.yml）的小工具（[本地补丁 阶段 2] 2026-10-12）
 *
 * 为什么要它：
 *   - 桥接仓库是零依赖的（不引 yaml 库），而 profile patch 里全是注释与嵌套块；
 *   - 控制台要能"改用户配置"，就必须**只动我们负责的那几行**，其余一字不改 ——
 *     这是"升级/改配置不覆盖用户设置"这条硬约束的实现基础。
 *
 * 约定：所有函数都在**行数组**上工作（调用方自己读文件、自己写回），没有 IO。
 * 缩进不写死：以块内实际缩进为准（home patch 用 4 空格、profile patch 也用 4 空格，
 * 但插入块里是 6/8，一律按现场推导）。
 */

export const indentOf = (line) => (line.match(/^\s*/) ?? [''])[0].length

/** 定位 `- id: <id>` 块的行范围（含头不含尾）；找不到返回 null。 */
export function findBlock(lines, id) {
  let start = -1
  let idIndent = 0
  const re = new RegExp(`^(\\s*)-\\s*id:\\s*['"]?${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`)
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (m) { start = i; idIndent = m[1].length; break }
  }
  if (start < 0) return null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^#\s*<<<.+>>>\s*$/.test(line)) return { start, end: i, id }
    const indent = indentOf(line)
    if (indent <= idIndent && /^\s*-\s/.test(line)) return { start, end: i, id }
    if (indent === 0 && !line.startsWith('#')) return { start, end: i, id }
  }
  return { start, end: lines.length, id }
}

/** 块内 `config:` 行的下标；没有返回 -1。 */
export function findConfigLine(lines, block) {
  for (let i = block.start; i < block.end; i++) {
    if (/^\s*config:\s*$/.test(lines[i])) return i
  }
  return -1
}

/** 取标量值（块内第一个匹配；去掉行尾注释与包裹引号）。 */
export function scalar(lines, block, key) {
  const re = new RegExp(`^\\s*${key}:\\s*(.*)$`)
  for (let i = block.start; i < block.end; i++) {
    const m = re.exec(lines[i])
    if (m) return strip(m[1])
  }
  return ''
}

/** 键是否存在（不管值空不空）——"只补缺"的判据。 */
export function hasKey(lines, block, key) {
  const re = new RegExp(`^\\s*${key}:`)
  for (let i = block.start; i < block.end; i++) if (re.test(lines[i])) return true
  return false
}

const strip = (raw) => String(raw ?? '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')

/** 解析 `[1, 2]` 形态的数组（兼容空数组与空值）。 */
export function parseList(raw) {
  const text = String(raw ?? '').trim()
  if (text === '' || text === '[]') return []
  const inner = text.replace(/^\[/, '').replace(/\]$/, '')
  return inner.split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    .map((v) => (/^-?\d+$/.test(v) ? Number(v) : v))
}

/**
 * 段范围：从 `key:` 行到"下一个缩进不深于它的非空行"。
 * @param from/to 可把搜索限制在某个范围内（例如 identity 段内找 map 子映射）。
 */
export function findSection(lines, key, { from = 0, to = lines.length } = {}) {
  for (let i = from; i < to; i++) {
    if (new RegExp(`^(\\s*)${key}:\\s*$`).test(lines[i])) {
      const indent = indentOf(lines[i])
      let last = i
      for (let j = i + 1; j < to; j++) {
        const line = lines[j]
        if (line.trim() === '') { last = j; continue }
        if (indentOf(line) <= indent) break
        last = j
      }
      while (last > i && lines[last].trim() === '') last--
      return { start: i, end: last + 1, indent }
    }
  }
  return null
}

/** 段内标量。 */
export function sectionScalar(lines, section, key) {
  const re = new RegExp(`^\\s*${key}:\\s*(.*)$`)
  for (let i = section.start + 1; i < section.end; i++) {
    const m = re.exec(lines[i])
    if (m) return strip(m[1])
  }
  return ''
}

/** 段内子映射（map / groupRoles）的条目 → { id: value }。 */
export function sectionEntries(lines, section, key) {
  const sub = findSection(lines, key, { from: section.start, to: section.end })
  if (!sub) return {}
  const out = {}
  for (let i = sub.start + 1; i < sub.end; i++) {
    const m = /^\s*(['"]?)([^'":]+)\1:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const id = m[2].trim()
    if (id !== '') out[id] = strip(m[3])
  }
  return out
}

/**
 * 写标量：存在就替换，不存在就插到 `config:` 之后（新增，绝不覆盖别人的值）。
 * @returns 'updated' | 'added' | ''
 */
export function setScalar(lines, block, configLine, key, rawValue) {
  const re = new RegExp(`^(\\s*)${key}:\\s*(.*)$`)
  for (let i = block.start; i < block.end; i++) {
    const m = re.exec(lines[i])
    if (m) { lines[i] = `${m[1]}${key}: ${rawValue}`; return 'updated' }
  }
  if (configLine < 0) return ''
  const indent = ' '.repeat(indentOf(lines[configLine]) + 2)
  lines.splice(configLine + 1, 0, `${indent}${key}: ${rawValue}`)
  block.end += 1
  return 'added'
}

/** 段内标量：存在就替换，不存在就追加到段尾。 */
export function setSectionScalar(lines, section, key, rawValue) {
  const re = new RegExp(`^(\\s*)${key}:\\s*(.*)$`)
  for (let i = section.start + 1; i < section.end; i++) {
    const m = re.exec(lines[i])
    if (m) { lines[i] = `${m[1]}${key}: ${rawValue}`; return 'updated' }
  }
  const indent = ' '.repeat(section.indent + 2)
  lines.splice(section.end, 0, `${indent}${key}: ${rawValue}`)
  section.end += 1
  return 'added'
}

/**
 * 重写子映射的条目（保留子映射里的注释行，只删旧条目再写新条目）。
 * entries 为空 = 清空条目（保留空的 `key:` 行）。
 */
export function rewriteEntries(lines, section, key, entries) {
  const pairs = Object.entries(entries)
  let sub = findSection(lines, key, { from: section.start, to: section.end })
  if (!sub) {
    if (pairs.length === 0) return 'noop'
    const indent = ' '.repeat(section.indent + 2)
    const entryIndent = ' '.repeat(section.indent + 4)
    lines.splice(section.end, 0, `${indent}${key}:`, ...pairs.map(([id, value]) => `${entryIndent}"${id}": ${value}`))
    section.end += 1 + pairs.length
    return 'added'
  }
  const entryIndent = ' '.repeat(sub.indent + 2)
  for (let i = sub.end - 1; i > sub.start; i--) {
    if (/^\s*(['"]?)[^'":]+\1:\s*\S/.test(lines[i])) lines.splice(i, 1)
  }
  if (pairs.length === 0) return 'cleared'
  sub = findSection(lines, key, { from: section.start, to: section.end })
  const at = sub ? sub.end : section.end
  lines.splice(at, 0, ...pairs.map(([id, value]) => `${entryIndent}"${id}": ${value}`))
  return 'updated'
}

/** 追加一个 `- id:` 块（首启播种用）：缩进按 0（home patch 顶层数组）。 */
export function appendBlock(lines, id, bodyLines) {
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
  lines.push(`- id: ${id}`, ...bodyLines.map((l) => `  ${l}`))
  return lines.length
}
