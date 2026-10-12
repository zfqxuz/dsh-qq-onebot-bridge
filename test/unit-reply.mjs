/** Unit-test quote (reply) segment parsing. */
import { parseMessage } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// array form with reply segment
const r1 = parseMessage([{ type: 'reply', data: { id: '12345', text: '原消息摘要' } }, { type: 'text', data: { text: '看看这个' } }], 0)
check('array reply id', r1.reply?.messageId === '12345', JSON.stringify(r1.reply))
check('array reply text', r1.reply?.text === '原消息摘要')
check('array text stripped', r1.text === '看看这个', r1.text)

// string form with CQ reply code
const r2 = parseMessage('[CQ:reply,id=999,text=引用内容][CQ:at,qq=10001] 分析一下', 10001)
check('string reply id', r2.reply?.messageId === '999', JSON.stringify(r2.reply))
check('string reply text', r2.reply?.text === '引用内容')
check('string at parsed', r2.ats.includes(10001), JSON.stringify(r2.ats))
check('string text stripped', r2.text === '分析一下', r2.text)

// no reply
const r3 = parseMessage('普通消息', 0)
check('no reply', r3.reply === null, JSON.stringify(r3.reply))


// 文件段（2026-10-12 收群文件用）：群文件通常只给 file_id，必须把 file_id/busid/size 带出来
const r4 = parseMessage([{ type: 'file', data: { name: 'a.txt', file_id: 'fid-9', busid: 102, size: 1234 } }], 0)
check('file 段：name/url', r4.files.length === 1 && r4.files[0].name === 'a.txt', JSON.stringify(r4.files))
check('file 段：file_id/busid/size', r4.files[0].fileId === 'fid-9' && r4.files[0].busid === 102 && r4.files[0].size === 1234, JSON.stringify(r4.files[0]))
const r5 = parseMessage('[CQ:file,name=b.zip,file_id=fid-7,busid=15,size=88]', 0)
check('CQ 字符串形式的文件段也能解析', r5.files.length === 1 && r5.files[0].fileId === 'fid-7' && r5.files[0].busid === 15, JSON.stringify(r5.files))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
