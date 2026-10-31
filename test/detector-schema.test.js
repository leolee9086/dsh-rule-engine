import test from 'node:test'
import assert from 'node:assert/strict'
import { detectorValidator } from '../lib/detector-protocol.js'
import { createBoundedMatcher, createDetectorRegistry, normalizeRuleV2 } from '../lib/index.js'

// Exercise cold workers with the real default 250ms budget and 50ms callbacks.
// Assert the stream's result/state; no timing threshold, retry or prewarm hides a failure.
test('cold concurrent detector workers preserve incremental state within the default work budget', async () => {
  const specification = { plugin: 'cold-test', ref: 'test:letters', revision: 1, on: ['output.delta'],
    paramsSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false },
    stateSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    resultSchema: {}, workerCallbacks: {
      initialize: '() => ({ text: "" })',
      feed: '({ state, params, delta }) => { state.text += delta; return { state, result: { ok: state.text.includes(params.token), ranges: [], captures: {}, facts: { text: state.text } } } }',
      finalize: '({ state }) => ({ state, result: { ok: false, ranges: [], captures: {} } })',
      reset: '() => ({ text: "" })',
    } }
  const rule = normalizeRuleV2({ schemaVersion: 2, sourceId: 'cold-test', id: 'letters', revision: 1, on: ['output.delta'],
    select: { view: 'original', roles: ['assistant'], blockTypes: ['text'] },
    match: { kind: 'detector', ref: 'test:letters', revision: 1, params: { token: 'ab' } },
    actions: [{ id: 'notify', kind: 'notify', stage: 'output.delta', enabledDefault: true, template: 'hit' }] })
  const operations = Array.from({ length: 4 }, async () => {
    const matcher = createBoundedMatcher(), registry = createDetectorRegistry(matcher)
    const options = { sessionId: 's', scope: 's/request/attempt', epoch: 'p' }
    const input = text => ({ stage: 'output.delta', rules: [rule], blocks: [{ id: 'b', view: 'original', role: 'assistant', type: 'text', text }] })
    try {
      registry.register(specification)
      assert.equal((await registry.detect(input('a'), undefined, options)).length, 0)
      const found = await registry.detect(input('ab'), undefined, options)
      assert.equal(found.length, 1)
      assert.deepEqual(found[0].facts, { text: 'ab' })
    } finally { try { await registry.close() } finally { await matcher.close() } }
  })
  const outcomes = await Promise.allSettled(operations)
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
})

test('reused detector compiler keeps independent schemas, local refs and failed compilations isolated', () => {
  const id = 'https://example.test/detector'
  const text = detectorValidator({ $id: id, type: 'string' })
  const number = detectorValidator({ $id: id, type: 'number' })
  assert.equal(text('ok'), true)
  assert.equal(text(1), false)
  assert.equal(number(1), true)
  assert.equal(number('ok'), false)
  // A previous detector's schema must never satisfy a later detector's external ref.
  assert.throws(() => detectorValidator({ $ref: id }), /can't resolve reference/)
  const recursive = detectorValidator({ $id: id, type: 'object', properties: { next: { $ref: '#' } }, additionalProperties: false })
  assert.equal(recursive({ next: { next: {} } }), true)
  assert.equal(recursive({ next: 1 }), false)
  assert.throws(() => detectorValidator({ $id: id, type: 'not-a-json-schema-type' }), /schema is invalid/)
  assert.equal(detectorValidator({ $id: id, type: 'boolean' })(false), true)
  assert.equal(detectorValidator(false)(null), false)
  assert.equal(detectorValidator(true)(null), true)
  // Both draft-07 meta-schema names accepted by a fresh Ajv must survive reuse.
  assert.equal(detectorValidator({ $schema: 'http://json-schema.org/schema#', type: 'string' })('ok'), true)
  // Clearing compiler entries must not disable meta-schema validation on reuse.
  assert.throws(() => detectorValidator({ type: 'not-a-json-schema-type' }), /schema is invalid/)
})
