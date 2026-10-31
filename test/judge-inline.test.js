import test from 'node:test'
import assert from 'node:assert/strict'
import { executeEventMatch } from '../lib/event-matcher.js'

// 内联 judge（规则自带源码）的契约：编译一次、异步可用、state 跨调用持久、错误不被吞。
// 断言只看行为，不卡时间阈值。

const limits = { maxTextChars: 32768, maxCandidates: 10000, maxUnits: 10000, maxEvidence: 32 }
const event = { sessionId: 'session-a', callId: 'call-1', rootCallId: 'call-1' }
const input = (judge, params = null) => ({ condition: { kind: 'always' }, event, maxBytes: 1048576, countLimits: limits, judge, params })

test('内联 judge：同步函数返回 ok', async () => {
  const out = await executeEventMatch(input({ code: '() => ({ ok: true })' }))
  assert.equal(out.ok, true)
  assert.equal(out.status, 'matched')
})

test('内联 judge：async 函数同样支持', async () => {
  const out = await executeEventMatch(input({ code: 'async () => ({ ok: true })' }))
  assert.equal(out.ok, true)
})

test('内联 judge：ok:false 就是不匹配，但不报错', async () => {
  const out = await executeEventMatch(input({ code: '() => ({ ok: false })' }))
  assert.equal(out.ok, false)
  assert.equal(out.status, 'unmatched')
})

test('内联 judge：能读到 params', async () => {
  const out = await executeEventMatch(input({ code: '({ params }) => ({ ok: params.flag === true })' }, { flag: true }))
  assert.equal(out.ok, true)
})

test('内联 judge：state 在同一段源码上跨调用持久', async () => {
  const code = '({ state }) => { const n = (state.get("k") ?? 0) + 1; state.set("k", n); return { ok: true, facts: { n } } }'
  const first = await executeEventMatch(input({ code }))
  const second = await executeEventMatch(input({ code }))
  assert.equal(first.facts.n, 1)
  assert.equal(second.facts.n, 2)
})

test('内联 judge：不同源码的 state 互相隔离', async () => {
  const codeA = '({ state }) => { const n = (state.get("k") ?? 0) + 1; state.set("k", n); return { ok: true, facts: { n } } } // a'
  const codeB = '({ state }) => ({ ok: true, facts: { n: state.get("k") ?? 0 } }) // b'
  const a = await executeEventMatch(input({ code: codeA }))
  const b = await executeEventMatch(input({ code: codeB }))
  assert.equal(a.facts.n, 1)
  assert.equal(b.facts.n, 0)
})

test('内联 judge：抛错向上报错', async () => {
  await assert.rejects(() => executeEventMatch(input({ code: '() => { throw new Error("boom") }' })), /boom/)
})

test('内联 judge：拿不到 helpers 以外的引擎内部能力', async () => {
  const out = await executeEventMatch(input({ code: '({ helpers }) => ({ ok: typeof helpers.detectDegradation === "function" })' }))
  assert.equal(out.ok, true)
})

test('内联 judge：ctx 提供 random', async () => {
  const out = await executeEventMatch(input({ code: '({ random }) => ({ ok: typeof random === "function" && random() < 2 })' }))
  assert.equal(out.ok, true)
})

test('内联 judge：可以用 random 与 params 做概率判定', async () => {
  const code = '({ random, params }) => ({ ok: random() < params.probability })'
  const never = await executeEventMatch(input({ code }, { probability: 0 }))
  const always = await executeEventMatch(input({ code }, { probability: 1 }))
  assert.equal(never.ok, false)
  assert.equal(always.ok, true)
})
