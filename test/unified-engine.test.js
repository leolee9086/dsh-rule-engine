import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, normalizeRule, createBoundedMatcher, createDetectorRegistry, createExecutorRegistry } from '../lib/index.js'

const stageRule = (sourceId, extra = {}) => ({ schemaVersion: 2, sourceId, id: 'shared', revision: 1,
  on: ['output.delta'], select: { view: 'original', roles: ['assistant'], blockTypes: ['text'] },
  match: { kind: 'keywords', values: ['MARK'], mode: 'ANY' }, actions: [{ id: 'notice', kind: 'notify', stage: 'output.delta', enabledDefault: true, template: 'seen' }], ...extra })
const block = text => ({ id: 'b', view: 'original', role: 'assistant', type: 'text', text })

test('one source registry executes synchronous v1 rules and qualified stage sequences without synthetic notifications', () => {
  const engine = createEngine({ rules: [
    { id: 'rewrite', order: 1, placement: ['reasoning'], when: { findRegex: '/foo/g', replaceString: 'bar' }, action: { kind: 'transform' }, budget: { maxCacheLoss: 1 } },
    stageRule('left'), stageRule('right'),
  ] })
  const delivered = []
  engine.registerConsumer({ name: 'text', kinds: ['transform', 'notify'], handle: value => delivered.push(value.ruleId) })
  const result = engine.run({ surface: { placement: 'reasoning', text: 'foo' } })
  assert.equal(typeof result.then, 'undefined', 'the original run API stays synchronous')
  assert.equal(result.text, 'bar'); assert.deepEqual(delivered, ['rewrite'])
  assert.deepEqual(engine.rules().filter(rule => rule.schemaVersion === 2).map(rule => rule.action.kind), ['sequence', 'sequence'])
  assert.deepEqual(engine.detect({ blocks: [block('MARK')], stage: 'output.delta' }).map(event => event.sourceId), ['left', 'right'])
  const remove = engine.provideRules('dynamic', () => [stageRule('dynamic')])
  assert.equal(engine.detect({ blocks: [block('MARK')], stage: 'output.delta' }).length, 3)
  remove()
  assert.equal(engine.detect({ blocks: [block('MARK')], stage: 'output.delta' }).length, 2)
  assert.throws(() => createEngine({ rules: [stageRule('left'), stageRule('left')] }), /duplicate rule id/)
  const normalized = normalizeRule(stageRule('roundtrip'), 0)
  assert.deepEqual(normalizeRule(normalized, 0), normalized)
})

test('v1 payloads retain their own definition when stage rules reuse the same local id', () => {
  const engine = createEngine({ rules: [{ id: 'shared', order: 0, placement: ['reasoning'], action: { kind: 'notify', say: 'v1' } }, stageRule('stage')] })
  const received = []
  engine.registerConsumer({ name: 'listener', kinds: ['notify'], handle: payload => received.push(payload) })
  engine.run({ surface: { text: 'MARK', placement: 'reasoning' } })
  assert.equal(received.length, 1); assert.equal(received[0].rule.action.kind, 'notify'); assert.equal(received[0].action.say, 'v1')
  assert.deepEqual(engine.detect({ stage: 'output.delta', blocks: [block('MARK')] }).map(event => event.sourceId), ['stage'])
})

test('old source and consumer disposers cannot remove replacement owners', () => {
  const engine = createEngine(), produce = () => [{ id: 'shared', order: 0, placement: ['reasoning'], action: { kind: 'notify', say: 'notice' } }]
  const oldSource = engine.provideRules('source', produce), currentSource = engine.provideRules('source', produce)
  oldSource(); assert.equal(engine.rules().length, 1, 'same function identity still has a new owner')
  const received = [], consumer = { name: 'listener', kinds: ['notify'], handle: payload => received.push(payload.action.say) }
  const oldConsumer = engine.registerConsumer(consumer), currentConsumer = engine.registerConsumer(consumer)
  oldConsumer(); engine.run({ surface: { text: 'test', placement: 'reasoning' } }); assert.deepEqual(received, ['notice'])
  currentSource(); currentConsumer(); assert.deepEqual(engine.sources(), []); assert.deepEqual(engine.consumers(), [])
})

test('the library worker runs builtin incremental detectors without plugin Worker imports', async () => {
  const matcher = createBoundedMatcher({ timeoutMs: 1000 }), registry = createDetectorRegistry(matcher)
  try {
    const engine = createEngine({ rules: [stageRule('engine', { match: { kind: 'detector', ref: 'context-care:marker', revision: 1, params: { token: 'MARK' } } })] })
    const options = { sessionId: 'session', scope: 'session/request/attempt', epoch: 'policy' }
    const detect = text => registry.detect({ rules: engine.rules(), stage: 'output.delta', blocks: [block(text)] }, undefined, options)
    assert.equal((await detect('MA')).length, 0)
    const found = await detect('MARK')
    assert.equal(found.length, 1); assert.equal(found[0].facts.kind, 'marker')
    await registry.release(options.scope)
    assert.equal((await detect('RK')).length, 0, 'released streams do not reuse earlier partial text')
  } finally { await registry.close(); await matcher.close() }
})

test('executor budgets measure the full native result before projecting action-visible values', async () => {
  let projections = 0
  const registry = createExecutorRegistry({ available: () => true,
    execute: async () => ({ value: 'ok', content: [], nativeMetadata: 'x'.repeat(256) }),
    result: raw => { projections++; return { value: raw.value, content: raw.content } },
  })
  registry.registerTool({ plugin: 'test', executorRef: 'test:tool', toolName: 'native-tool', inputSchema: { type: 'object' }, requiresApproval: false, maxResultBytes: 64 })
  const executor = registry.get('test:tool')
  await assert.rejects(executor.run({ agent: {}, inputs: {}, signal: new AbortController().signal, runId: 'run' }), error => error.message === 'executor-result-budget-exceeded' && error.outcomeUnconfirmed === true)
  assert.equal(projections, 0)
  registry.close()
})
