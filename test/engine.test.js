import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/engine.js'
import { PLACEMENT } from '../lib/placement.js'

function transformRule(overrides = {}) {
  return {
    id: 'r', order: 1, action: { kind: 'transform' }, placement: ['reasoning'],
    when: { findRegex: '/foo/', replaceString: 'bar' },
    budget: { maxCacheLoss: 1 },
    ...overrides,
  }
}

function surface(text) {
  return { placement: PLACEMENT.REASONING, text }
}

test('消费者注册：按 action.by 找，把动作交过去', () => {
  const seen = []
  const engine = createEngine({ rules: [transformRule({ action: { kind: 'transform', by: 'fetch-router' } })] })
  engine.registerConsumer({ name: 'fetch-router', kinds: ['transform'], handle: payload => seen.push(payload) })
  const result = engine.run({ surface: surface('foo') })
  assert.equal(result.text, 'bar')
  assert.deepEqual(result.delivered, ['fetch-router'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, 'bar')
})

test('没指名消费者时交给所有声明消费这种动作的人', () => {
  const hits = []
  const engine = createEngine({ rules: [transformRule()] })
  engine.registerConsumer({ name: 'a', kinds: ['transform'], handle: () => hits.push('a') })
  engine.registerConsumer({ name: 'b', kinds: ['transform'], handle: () => hits.push('b') })
  engine.registerConsumer({ name: 'c', kinds: ['notify'], handle: () => hits.push('c') })
  const result = engine.run({ surface: surface('foo') })
  assert.deepEqual(hits, ['a', 'b'])
  assert.deepEqual(result.delivered.sort(), ['a', 'b'])
})

test('没人接的时候篡改不生效：请求保持原样，只留下一条失效记录', () => {
  const records = []
  const engine = createEngine({
    rules: [transformRule({ action: { kind: 'transform', by: 'nobody' } })],
    onRecord: record => records.push(record),
  })
  const result = engine.run({ surface: surface('foo') })
  assert.deepEqual(result.delivered, [])
  assert.equal(result.text, 'foo')
  assert.equal(records[0].outcome, 'no-consumer')
  assert.equal(records[0].changed, false)
  assert.match(records[0].detail, /没有生效/)
})

test('指名了消费者但那个消费者不接这种动作，同样不生效', () => {
  const engine = createEngine({ rules: [transformRule({ action: { kind: 'transform', by: 'watcher' } })] })
  engine.registerConsumer({ name: 'watcher', kinds: ['notify'], handle: () => {} })
  const result = engine.run({ surface: surface('foo') })
  assert.equal(result.text, 'foo')
  assert.equal(result.records[0].outcome, 'no-consumer')
})

test('没有任何消费者时，notify 也不生效（但不会报错）', () => {
  const engine = createEngine({
    rules: [{ id: 'n', order: 1, action: { kind: 'notify' }, placement: ['reasoning'], when: { findRegex: '/foo/' } }],
  })
  const result = engine.run({ surface: surface('foo') })
  assert.equal(result.records[0].outcome, 'no-consumer')
  assert.equal(result.records[0].kind, 'notify')
})

test('冷却：冷却期内不再触发，时间过了又能触发', () => {
  let now = 1000
  const engine = createEngine({ rules: [transformRule({ cooldownMinutes: 10 })], now: () => now })
  engine.registerConsumer({ name: 'c', kinds: ['transform'], handle: () => {} })
  assert.equal(engine.run({ surface: surface('foo') }).records[0].outcome, 'applied')
  const second = engine.run({ surface: surface('foo') })
  assert.equal(second.records[0].outcome, 'cooldown')
  assert.equal(second.text, 'foo')
  now += 11 * 60000
  assert.equal(engine.run({ surface: surface('foo') }).records[0].outcome, 'applied')
})

test('oncePerSurface：同一个 surface 上只出现一次，换一段就又能跑', () => {
  const engine = createEngine({ rules: [transformRule({ oncePerSurface: true })] })
  engine.registerConsumer({ name: 'c', kinds: ['transform'], handle: () => {} })
  assert.equal(engine.run({ surface: surface('foo') }).records[0].outcome, 'applied')
  assert.equal(engine.run({ surface: surface('foo') }).records[0].outcome, 'duplicate')
  assert.equal(engine.run({ surface: surface('foo bar') }).records[0].outcome, 'applied')
})

test('外部传进来的 surfaces 也算数（跨重启仍然有效）', () => {
  const engine = createEngine({ rules: [transformRule({ oncePerSurface: true })] })
  engine.registerConsumer({ name: 'c', kinds: ['transform'], handle: () => {} })
  const print = engine.fingerprintOf('r', 'foo')
  const result = engine.run({ surface: surface('foo'), ctx: { surfaces: [print] } })
  assert.equal(result.records[0].outcome, 'duplicate')
})

test('规则来源：运行时由别的插件提供', () => {
  let extra = []
  const engine = createEngine({})
  engine.provideRules('memory-plugin', () => extra)
  engine.registerConsumer({ name: 'c', kinds: ['notify'], handle: () => {} })
  assert.equal(engine.run({ surface: surface('foo') }).hits.length, 0)
  extra = [{ id: 'from-source', order: 1, action: { kind: 'notify' }, placement: ['reasoning'], when: { findRegex: '/foo/' } }]
  assert.equal(engine.run({ surface: surface('foo') }).hits.length, 1)
  assert.deepEqual(engine.sources(), ['memory-plugin'])
})

test('来源给的规则非法时抛错，并指出是哪个来源', () => {
  const engine = createEngine({})
  engine.provideRules('bad', () => [{ id: 'x', action: { kind: 'notify' } }])
  assert.throws(() => engine.run({ surface: surface('foo') }), /rule source "bad"/)
})

test('静态规则非法时直接拒绝安装', () => {
  assert.throws(() => createEngine({ rules: [{ id: 'x', action: { kind: 'notify' } }] }), /explicit order/)
})

test('每次命中都留下一条记录', () => {
  const records = []
  const engine = createEngine({ rules: [transformRule()], onRecord: record => records.push(record) })
  engine.registerConsumer({ name: 'c', kinds: ['transform'], handle: () => {} })
  const result = engine.run({ surface: surface('foo') })
  assert.equal(records.length, 1)
  assert.deepEqual(records[0], result.records[0])
  assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'changed', 'detail', 'kind', 'loss', 'outcome', 'placement', 'ruleId'])
})

test('消费者注册与规则来源都做参数校验', () => {
  const engine = createEngine({})
  assert.throws(() => engine.registerConsumer({ name: 'c', kinds: ['shout'], handle: () => {} }), /unknown kind/)
  assert.throws(() => engine.registerConsumer({ name: 'c', kinds: [], handle: () => {} }), /needs kinds/)
  assert.throws(() => engine.registerConsumer({ name: 'c', kinds: ['notify'] }), /handle/)
  assert.throws(() => engine.provideRules('', () => []), /needs a name/)
  assert.throws(() => engine.provideRules('x', null), /needs a function/)
})

test('取消注册后不再生效', () => {
  const engine = createEngine({})
  const off = engine.registerConsumer({ name: 'c', kinds: ['notify'], handle: () => {} })
  assert.deepEqual(engine.consumers(), ['c'])
  off()
  assert.deepEqual(engine.consumers(), [])
})
