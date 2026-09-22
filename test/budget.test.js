import test from 'node:test'
import assert from 'node:assert/strict'
import { byteLength, commonPrefixBytes, cacheLossRatio, selectWithinBudget } from '../lib/budget.js'

test('byteLength：按 UTF-8 算，非字符串抛错', () => {
  assert.equal(byteLength('abc'), 3)
  assert.equal(byteLength('织'), 3)
  assert.equal(byteLength(''), 0)
  assert.throws(() => byteLength(undefined), TypeError)
})

test('commonPrefixBytes：按字节，不切半个字符', () => {
  assert.equal(commonPrefixBytes('abcdef', 'abcxyz'), 3)
  assert.equal(commonPrefixBytes('abc', 'abc'), 3)
  assert.equal(commonPrefixBytes('', 'abc'), 0)
  assert.equal(commonPrefixBytes('织', '织'), 3)
  assert.equal(commonPrefixBytes('织', '的'), 0)
  // 代理对：切点不会落在半个字符上（一个 emoji 是 4 字节）。
  assert.equal(commonPrefixBytes('😀a', '😀b'), 4)
  assert.equal(commonPrefixBytes('😀a', '😀'), 4)
})

test('cacheLossRatio：废掉的字节 / 上一次请求的总字节', () => {
  const previous = 'a'.repeat(100)
  assert.equal(cacheLossRatio(previous, previous, previous), 0)
  // 改最后一位：只废掉 1 字节。
  assert.equal(cacheLossRatio(previous, previous, 'a'.repeat(99) + 'b'), 0.01)
  // 改第一位：整条前缀全废。
  assert.equal(cacheLossRatio(previous, previous, 'b' + 'a'.repeat(99)), 1)
  // 没有上一次请求，就没有缓存可失效。
  assert.equal(cacheLossRatio(null, previous, 'b' + 'a'.repeat(99)), 0)
})

test('selectWithinBudget：从尾部往前贪心，越靠后越便宜', () => {
  const segments = ['A'.repeat(100), 'B'.repeat(100), 'C'.repeat(100)]
  const previous = segments.join('')
  const replacements = [
    { index: 0, text: 'X'.repeat(100) },
    { index: 1, text: 'Y'.repeat(100) },
    { index: 2, text: 'Z'.repeat(100) },
  ]
  const plan = selectWithinBudget({ previous, segments, replacements, maxCacheLoss: 0.4 })
  assert.deepEqual(plan.accepted, [2])
  assert.deepEqual(plan.rejected, [0, 1])
  assert.equal(plan.text, 'A'.repeat(100) + 'B'.repeat(100) + 'Z'.repeat(100))
  assert.equal(plan.exceedsBudget, false)
})

test('selectWithinBudget：预算够时可以往前多改一段', () => {
  const segments = ['A'.repeat(100), 'B'.repeat(100), 'C'.repeat(100)]
  const previous = segments.join('')
  const replacements = [
    { index: 0, text: 'X'.repeat(100) },
    { index: 1, text: 'Y'.repeat(100) },
    { index: 2, text: 'Z'.repeat(100) },
  ]
  const plan = selectWithinBudget({ previous, segments, replacements, maxCacheLoss: 0.7 })
  assert.deepEqual(plan.accepted, [1, 2])
  assert.deepEqual(plan.rejected, [0])
})

test('selectWithinBudget：required 无条件接受，代价照算', () => {
  const segments = ['A'.repeat(100), 'B'.repeat(100)]
  const previous = segments.join('')
  const plan = selectWithinBudget({
    previous,
    segments,
    replacements: [
      { index: 0, text: 'X'.repeat(100), required: true },
      { index: 1, text: 'Y'.repeat(100) },
    ],
    maxCacheLoss: 0.1,
  })
  assert.deepEqual(plan.forced, [0])
  assert.deepEqual(plan.accepted, [0])
  assert.deepEqual(plan.rejected, [1])
  // 隐私清洗这类「不做就不能发」的变换本身就超预算 —— 调用方据此拒绝发送。
  assert.equal(plan.exceedsBudget, true)
})

test('selectWithinBudget：没有上一次请求时全部接受', () => {
  const plan = selectWithinBudget({
    previous: null,
    segments: ['A', 'B'],
    replacements: [{ index: 0, text: 'X' }, { index: 1, text: 'Y' }],
    maxCacheLoss: 0,
  })
  assert.deepEqual(plan.accepted, [0, 1])
  assert.equal(plan.exceedsBudget, false)
  assert.equal(plan.text, 'XY')
})
