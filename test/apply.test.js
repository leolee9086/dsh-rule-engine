import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRules } from '../lib/apply.js'
import { normalizeRules } from '../lib/rules.js'
import { PLACEMENT } from '../lib/placement.js'

function rules(list) {
  return normalizeRules(list)
}

function surface(text, overrides = {}) {
  return { placement: PLACEMENT.REASONING, text, ...overrides }
}

/** 一条 transform 规则的骨架：预算给足，先只测变换本身。 */
function transformRule(overrides = {}) {
  return {
    id: 'r', order: 1, action: { kind: 'transform' }, placement: ['reasoning'],
    when: { findRegex: '/foo/', replaceString: 'bar' },
    budget: { maxCacheLoss: 1 },
    ...overrides,
  }
}

test('逐条规则依次作用：前一条的结果是后一条的输入', () => {
  const list = rules([
    transformRule({ id: 'a', order: 1 }),
    transformRule({ id: 'b', order: 2, when: { findRegex: '/bar/', replaceString: 'baz' } }),
  ])
  const { text, hits } = applyRules({ rules: list, surface: surface('x foo y') })
  assert.equal(text, 'x baz y')
  assert.deepEqual(hits.map(hit => hit.ruleId), ['a', 'b'])
  assert.equal(hits[0].changed, true)
})

test('没命中的规则不进 hits', () => {
  const list = rules([{ id: 'a', order: 1, action: { kind: 'notify' }, placement: ['user'], when: { findRegex: '/foo/' } }])
  assert.deepEqual(applyRules({ rules: list, surface: surface('foo') }).hits, [])
})

test('notify 类规则不改文本，只产出动作', () => {
  const list = rules([{ id: 'n', order: 1, action: { kind: 'notify', by: 'context-care' }, placement: ['reasoning'], when: { findRegex: '/foo/' } }])
  const { text, hits } = applyRules({ rules: list, surface: surface('x foo y') })
  assert.equal(text, 'x foo y')
  assert.equal(hits[0].kind, 'notify')
  assert.equal(hits[0].applied, true)
})

test('规则自己的缓存预算：改动在头部就跳过这条变换', () => {
  const previous = 'A'.repeat(100)
  const list = rules([transformRule({
    id: 'head', when: { findRegex: '/^A/', replaceString: 'X' }, budget: { maxCacheLoss: 0.5 },
  })])
  const { text, hits } = applyRules({ rules: list, surface: surface(previous), previous })
  assert.equal(text, previous)
  assert.equal(hits[0].applied, false)
  assert.equal(hits[0].outcome, 'over-budget')
})

test('规则自己的缓存预算：改动在尾部很便宜，能过', () => {
  const previous = 'A'.repeat(100)
  const list = rules([transformRule({
    id: 'tail', when: { findRegex: '/A$/', replaceString: 'B' }, budget: { maxCacheLoss: 0.5 },
  })])
  const { text, hits } = applyRules({ rules: list, surface: surface(previous), previous })
  assert.equal(text, 'A'.repeat(99) + 'B')
  assert.equal(hits[0].applied, true)
  assert.equal(hits[0].loss, 0.01)
})

test('没有上一次请求时，代价一律是 0', () => {
  const list = rules([transformRule({ id: 'head', when: { findRegex: '/^A/', replaceString: 'X' }, budget: { maxCacheLoss: 0 } })])
  assert.equal(applyRules({ rules: list, surface: surface('AAA') }).text, 'XAA')
})

test('gate 挡下的规则不改文本，并记下原因', () => {
  const list = rules([transformRule()])
  const { text, hits } = applyRules({
    rules: list,
    surface: surface('foo'),
    gate: () => ({ ok: false, outcome: 'cooldown', detail: '还在冷却' }),
  })
  assert.equal(text, 'foo')
  assert.equal(hits[0].applied, false)
  assert.equal(hits[0].outcome, 'cooldown')
  assert.equal(hits[0].detail, '还在冷却')
})

test('gate 返回 undefined 表示放行；返回别的东西就是写错了', () => {
  const list = rules([transformRule()])
  assert.equal(applyRules({ rules: list, surface: surface('foo'), gate: () => undefined }).text, 'bar')
  assert.throws(() => applyRules({ rules: list, surface: surface('foo'), gate: () => 'ok' }), TypeError)
})

test('判命中和实际替换用的是同一个正则（宏替换也要走一遍）', () => {
  const list = rules([transformRule({ when: { findRegex: '/{{q}}/', replaceString: '织', substituteRegex: 1 } })])
  const macros = text => text.replaceAll('{{q}}', 'hi')
  assert.equal(applyRules({ rules: list, surface: surface('say hi'), macros }).text, 'say 织')
  // 宏替换后匹配不上就是不命中，不是「命中但没替换」。
  assert.deepEqual(applyRules({ rules: list, surface: surface('say yo'), macros }).hits, [])
})

test('入参形状不对时抛错，不悄悄按空处理', () => {
  const list = rules([transformRule()])
  assert.throws(() => applyRules({ rules: 'nope', surface: surface('foo') }), TypeError)
  assert.throws(() => applyRules({ rules: list, surface: null }), TypeError)
  assert.throws(() => applyRules({ rules: list, surface: { placement: 'reasoning' } }), /surface.text must be a string/)
  assert.throws(() => applyRules({ rules: list, surface: surface('foo'), gate: 'nope' }), TypeError)
})
