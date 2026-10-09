/**
 * 语料库解析层验收（SPEC-rbac-console.md §6）。
 *
 * 覆盖：
 *   - files 解析：目录里按名字排序的 .md/.txt，拼成 [{id,title,text}]；
 *   - 绑定 ∩ 白名单：绑定但没 persona.corpus:<id> 权限 → 不给（fail-closed）；
 *   - deny 覆盖：给了权限又被 deny → 不给；
 *   - 停用 / 目录不存在 / kind 没有 resolver → 记进 skipped，绝不让会话崩；
 *   - 失败路径（policy 为 null、目录是文件）返回空数组而不是抛。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { corpusPath, corpusSectionText, resolveCorpus, resolveCorpusDetailed } from '../lib/corpus.js'
import { emptyPolicy } from '../lib/acl.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-corpus-'))
const loreDir = join(root, 'lore')
const secretDir = join(root, 'secret')
mkdirSync(loreDir, { recursive: true })
mkdirSync(secretDir, { recursive: true })
writeFileSync(join(loreDir, '02-two.md'), '第二篇')
writeFileSync(join(loreDir, '01-one.md'), '第一篇')
writeFileSync(join(loreDir, 'ignore.json'), '{"x":1}')
writeFileSync(join(secretDir, 'secret.md'), '机密')

/** 造一份策略：guest 有 persona.text + persona.corpus:lore，没有 secret 的权限。 */
function policy() {
  const p = emptyPolicy()
  p.roles.guest.permissions = [...p.roles.guest.permissions, 'persona.corpus:lore']
  p.corpora = {
    lore: { id: 'lore', name: '世界观', kind: 'files', payloadRef: 'lore', enabled: true },
    secret: { id: 'secret', name: '机密', kind: 'files', payloadRef: 'secret', enabled: true },
    off: { id: 'off', name: '停用', kind: 'files', payloadRef: 'lore', enabled: false },
    weird: { id: 'weird', name: '别家', kind: 'vector', payloadRef: 'lore', enabled: true },
  }
  p.corpusBindings = { 'group:2001': ['lore', 'secret', 'off', 'weird'] }
  return p
}

const detail = resolveCorpusDetailed({ policy: policy(), subjectId: 'group:2001', root })
check('files 解析按文件名排序、只收 .md/.txt',
  detail.items.length === 2 && detail.items[0].title.includes('01-one') && detail.items[1].title.includes('02-two'),
  JSON.stringify(detail.items.map((x) => x.title)))
check('语料内容被带出来', detail.items[0].text === '第一篇', detail.items[0].text)
check('没有权限的语料被跳过（fail-closed）',
  detail.skipped.some((x) => x.id === 'secret' && x.reason.includes('persona.corpus:secret')), JSON.stringify(detail.skipped))
check('停用的语料被跳过', detail.skipped.some((x) => x.id === 'off'), JSON.stringify(detail.skipped))
check('没有 resolver 的 kind 被跳过', detail.skipped.some((x) => x.id === 'weird'), JSON.stringify(detail.skipped))
check('SPEC 约定的返回形状（resolveCorpus → 数组）',
  Array.isArray(resolveCorpus({ policy: policy(), subjectId: 'group:2001', root }))
  && resolveCorpus({ policy: policy(), subjectId: 'group:2001', root }).length === 2)

// 主体级 deny 覆盖角色授权
const deniedPolicy = policy()
deniedPolicy.subjectDenies = { 'group:2001': ['persona.corpus:lore'] }
const denied = resolveCorpusDetailed({ policy: deniedPolicy, subjectId: 'group:2001', root })
check('deny 覆盖：被 deny 的语料即使绑了也不给',
  denied.items.length === 0 && denied.skipped.some((x) => x.id === 'lore' && x.reason.includes('deny')), JSON.stringify(denied.skipped))

// 通配授权：persona.corpus:* 覆盖所有 id
const wildcardPolicy = policy()
wildcardPolicy.roles.guest.permissions = [...wildcardPolicy.roles.guest.permissions, 'persona.corpus:*']
const wildcard = resolveCorpusDetailed({ policy: wildcardPolicy, subjectId: 'group:2001', root })
check('persona.corpus:* 通配授权对任何语料生效',
  wildcard.items.some((x) => x.id === 'secret') && wildcard.items.filter((x) => x.id === 'lore').length === 2
  && !wildcard.skipped.some((x) => x.id === 'lore' || x.id === 'secret'),
  JSON.stringify({ items: wildcard.items.map((x) => x.id), skipped: wildcard.skipped }))

// 目录不存在 / 文件当目录
const missingPath = resolveCorpusDetailed({
  policy: { ...policy(), corpora: { lore: { id: 'lore', name: 'x', kind: 'files', payloadRef: 'no-such-dir', enabled: true } }, corpusBindings: { 'group:2001': ['lore'] } },
  subjectId: 'group:2001', root,
})
check('目录不存在 → skipped 而不是抛', missingPath.items.length === 0 && missingPath.skipped[0].reason.includes('目录不存在'), JSON.stringify(missingPath.skipped))

// 失败路径绝不抛
check('policy 为空 → 空数组', resolveCorpus({ policy: null, subjectId: 'group:2001', root }).length === 0)
check('参数为空 → 空数组', resolveCorpus().length === 0)

// 相对/绝对路径
check('corpusPath 相对路径按 root 解析', corpusPath('lore', '/data/corpora') === '/data/corpora/lore')
check('corpusPath 绝对路径原样', corpusPath('/etc/x', '/data/corpora') === '/etc/x')

// 段落拼接
const text = corpusSectionText(resolveCorpus({ policy: policy(), subjectId: 'group:2001', root }))
check('段落文本带标题与内容', text.includes('【世界观 / 01-one.md】') && text.includes('第一篇'), text.slice(0, 60))
check('空语料不产生段落', corpusSectionText([]) === '')

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
