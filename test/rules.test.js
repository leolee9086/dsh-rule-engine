import test from 'node:test'
import assert from 'node:assert/strict'
import { globMatch, normalizeRule, normalizeRules, sortRules, ACTION_KINDS } from '../lib/rules.js'
import { PLACEMENT, SCOPE } from '../lib/placement.js'

/** 一条最小的合法 notify 规则。 */
const NOTIFY = { id: 'notify-rule', order: 10, action: { kind: 'notify' } }
/** 一条最小的合法 transform 规则。 */
const TRANSFORM = {
  id: 'transform-rule', order: 10, action: { kind: 'transform' },
  when: { findRegex: '/a/', replaceString: 'b' }, budget: { maxCacheLoss: 0.1 },
}

test('globMatch：* 通配，不含 * 就是全等', () => {
  assert.equal(globMatch('*', 'anything'), true)
  assert.equal(globMatch('deepseek*', 'deepseek-chat'), true)
  assert.equal(globMatch('deepseek*', 'openai-gpt'), false)
  assert.equal(globMatch('a.b', 'axb'), false)
  assert.equal(globMatch('a.b', 'a.b'), true)
  assert.equal(globMatch('*', undefined), false)
  assert.throws(() => globMatch(undefined, 'x'), TypeError)
})

test('规范化：默认值', () => {
  const rule = normalizeRule(NOTIFY, 0)
  assert.equal(rule.id, 'notify-rule')
  assert.equal(rule.scope, SCOPE.GLOBAL)
  assert.equal(rule.order, 10)
  assert.equal(rule.enabled, true)
  assert.deepEqual(rule.placement, [])
  assert.deepEqual(rule.depth, { min: null, max: null })
  assert.equal(rule.cooldownMinutes, 0)
  assert.equal(rule.oncePerSurface, false)
})

test('规范化：id 与 order 都必须显式写出来', () => {
  assert.throws(() => normalizeRule({ order: 1, action: { kind: 'notify' } }, 0), /explicit non-empty id/)
  assert.throws(() => normalizeRule({ id: '', order: 1, action: { kind: 'notify' } }, 0), /explicit non-empty id/)
  assert.throws(() => normalizeRule({ id: 'x', action: { kind: 'notify' } }, 0), /explicit order/)
  assert.throws(() => normalizeRule({ id: 'x', order: 'high', action: { kind: 'notify' } }, 0), /explicit order/)
})

test('规范化：transform 必须说清楚换成什么、能废多少缓存', () => {
  const base = { id: 'x', order: 1, action: { kind: 'transform' } }
  assert.throws(() => normalizeRule(base, 0), /needs when.findRegex/)
  assert.throws(() => normalizeRule({ ...base, when: { findRegex: '/a/' } }, 0), /needs when.replaceString/)
  assert.throws(() => normalizeRule({ ...base, when: { findRegex: '/a/', replaceString: 'b' } }, 0), /needs budget.maxCacheLoss/)
  assert.throws(
    () => normalizeRule({ ...base, when: { findRegex: '/a/', replaceString: 'b' }, budget: {} }, 0),
    /needs budget.maxCacheLoss/,
  )
  // notify 不需要预算。
  assert.equal(normalizeRule(NOTIFY, 0).budget.maxCacheLoss, 0)
})

test('规范化：非法配置直接抛错', () => {
  assert.throws(() => normalizeRule(null, 0), /must be an object/)
  assert.throws(() => normalizeRule({ ...NOTIFY, scope: 9 }, 0), /unknown scope/)
  assert.throws(() => normalizeRule({ ...NOTIFY, placement: ['nowhere'] }, 0), /unknown placement/)
  assert.throws(() => normalizeRule({ ...NOTIFY, action: { kind: 'shout' } }, 0), /action.kind/)
  assert.throws(() => normalizeRule({ ...NOTIFY, action: { kind: 'notify', by: '' } }, 0), /action.by/)
  assert.throws(() => normalizeRule({ ...NOTIFY, cooldownMinutes: -1 }, 0), /cooldownMinutes/)
  assert.throws(() => normalizeRule({ ...NOTIFY, depth: 3 }, 0), /depth must be an object/)
  assert.throws(() => normalizeRule({ ...NOTIFY, budget: { maxCacheLoss: 1.5 } }, 0), /maxCacheLoss/)
  assert.throws(() => normalizeRule({ ...NOTIFY, budget: 5 }, 0), /budget must be an object/)
})

test('规范化：布尔字段给了就必须是布尔，不悄悄当成 false', () => {
  for (const field of ['enabled', 'markdownOnly', 'promptOnly', 'runOnEdit', 'oncePerSurface']) {
    assert.throws(() => normalizeRule({ ...NOTIFY, [field]: 'yes' }, 0), new RegExp(field + ' must be a boolean'))
  }
  assert.equal(normalizeRule({ ...NOTIFY, oncePerSurface: true }, 0).oncePerSurface, true)
})

test('规范化：when 里写坏的正则当场拒绝', () => {
  assert.throws(() => normalizeRule({ ...TRANSFORM, when: { findRegex: '/(/', replaceString: 'b' } }, 0), /not a valid regex/)
  assert.throws(() => normalizeRule({ ...TRANSFORM, when: { findRegex: '/a/z', replaceString: 'b' } }, 0), /not a valid regex/)
  assert.throws(() => normalizeRule({ ...NOTIFY, when: { said: '/(/' } }, 0), /not a valid regex/)
  assert.throws(() => normalizeRule({ ...NOTIFY, when: { trimStrings: [''] } }, 0), /trimStrings/)
  assert.throws(() => normalizeRule({ ...NOTIFY, when: { trimStrings: [1] } }, 0), /trimStrings/)
  assert.throws(() => normalizeRule({ ...NOTIFY, when: { substituteRegex: 9 } }, 0), /substituteRegex/)
  assert.throws(() => normalizeRule({ ...NOTIFY, when: { idle: { since: 'x' } } }, 0), /idle.minutes/)
  assert.throws(() => normalizeRule({ ...NOTIFY, when: { idle: { since: '', minutes: 1 } } }, 0), /idle.since/)
  assert.throws(() => normalizeRule({ ...NOTIFY, when: { args: { path: [] } } }, 0), /empty array/)
  assert.throws(() => normalizeRule({ ...NOTIFY, when: { provider: '' } }, 0), /provider/)
})

test('normalizeRules：默认空数组、非数组抛错、重复 id 抛错', () => {
  assert.deepEqual(normalizeRules(undefined), [])
  assert.deepEqual(normalizeRules(null), [])
  assert.throws(() => normalizeRules({}), /must be an array/)
  assert.throws(() => normalizeRules([NOTIFY, NOTIFY]), /duplicate rule id/)
})

test('排序：先 scope 后 order，同优先级按 id 定序（与声明顺序无关）', () => {
  const mk = (id, order, scope) => ({ id, order, scope, action: { kind: 'notify' } })
  const rules = normalizeRules([mk('b', 10), mk('a', 10), mk('c', 5), mk('d', 1, SCOPE.PRESET), mk('e', 99, SCOPE.SCOPED)])
  assert.deepEqual(rules.map(rule => rule.id), ['c', 'a', 'b', 'e', 'd'])
  // 换个声明顺序，结果一样。
  const again = normalizeRules([mk('e', 99, SCOPE.SCOPED), mk('d', 1, SCOPE.PRESET), mk('a', 10), mk('c', 5), mk('b', 10)])
  assert.deepEqual(again.map(rule => rule.id), ['c', 'a', 'b', 'e', 'd'])
})

test('sortRules 不改动入参', () => {
  const input = normalizeRules([NOTIFY])
  const copy = [...input]
  sortRules(input)
  assert.deepEqual(input, copy)
})

test('placement 常量齐全', () => {
  assert.deepEqual(Object.values(PLACEMENT), ['user', 'assistant', 'reasoning', 'tool-call', 'tool-result'])
  assert.deepEqual([...ACTION_KINDS], ['notify', 'transform'])
})
