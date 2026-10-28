import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, createTemplates, documentDeclarations, importTavernRegex, createBoundedMatcher, planRequestAsync, setRequestBlock, requestImpact, indexRequestPairs } from '../lib/index.js'

const transforms = (stage, scripts) => scripts.map((transform, index) => ({ schemaVersion: 2, sourceId: 'text', id: `r${index}`, revision: 1,
  priority: scripts.length - index, on: [stage], select: { view: stage === 'display.render' ? 'display' : 'model', roles: ['user'], blockTypes: ['text'] },
  match: { kind: 'always' }, actions: [{ id: 'rewrite', kind: 'transform', stage, enabledDefault: true, transform }] }))
const block = (text, view = 'display') => ({ id: 'b', path: '0', messageIndex: 0, view, role: 'user', type: 'text', text, raw: { type: 'text', text } })
const templates = createTemplates()
const display = (engine, blocks, snapshot = {}) => engine.display({ blocks, events: engine.detect({ blocks, stage: 'display.render' }), templates, snapshot,
  decision: () => ({ enabled: true }), maxInjectedChars: 65536, maxBytes: 8388608 })

test('the same action model preserves Tavern sequential results alongside original-coordinate patches', () => {
  const engine = createEngine({ rules: transforms('display.render', [{ findRegex: '/foo/g', replaceString: 'bar' }, { findRegex: '/bar/g', replaceString: 'baz' }]) })
  const original = block('foo')
  assert.equal(display(engine, [original]).after[0].text, 'baz')
  assert.equal(original.text, 'foo')
  assert.equal(original.raw.text, 'foo')
})

test('derived message depth builds one directory for the complete detection batch', () => {
  let reads = 0
  const blocks = Array.from({ length: 600 }, (_, index) => Object.defineProperty({ ...block('foo'), id: `b${index}` }, 'messageId', {
    enumerable: true, get() { reads++; return `m${Math.floor(index / 2)}` },
  }))
  const engine = createEngine({ rules: transforms('display.render', [{ findRegex: '/foo/', replaceString: 'bar' }]) })
  const events = engine.detect({ blocks, stage: 'display.render' })
  assert.equal(events.length, 600)
  assert.equal(events[0].block.surface.depth, 299); assert.equal(events[1].block.surface.depth, 299)
  assert.equal(events.at(-1).block.surface.depth, 0)
  assert.ok(reads < blocks.length * 10, `message identities must be read linearly: ${reads}`)
})

test('common plans preserve find macros, capture trimming and replacement macros', () => {
  const engine = createEngine({ rules: transforms('display.render', [{ findRegex: '/({{who}}.*)/g', substituteRegex: 2, trimStrings: ['trim'], replaceString: '$1 {{suffix}}' }]) })
  assert.equal(display(engine, [block('a.btrim')], { who: 'a.b', suffix: 'done' }).after[0].text, 'a.b done')
})

test('request plans execute the same sequential strategy and leave the original request intact', () => {
  const engine = createEngine({ rules: transforms('request.assemble', [{ findRegex: '/foo/g', replaceString: 'bar' }, { findRegex: '/bar/g', replaceString: 'baz' }]) })
  const b = block('foo', 'model'), request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'foo' }] }] }
  const events = engine.detect({ blocks: [b], stage: 'request.assemble' })
  // planDisplay and planRequest share the transformation strategy, while request ports only write native structure.
  return import('../lib/index.js').then(({ planRequest }) => {
    const result = planRequest({ request, blocks: [b], rules: engine.rules(), events, templates, snapshot: {}, decision: () => ({ enabled: true }),
      ports: { writeBlock(target, changed, value) { target.messages[changed.messageIndex].content[0] = value },
        insertionMessage() { throw new Error('unexpected insertion') }, pairs: () => ({ calls: new Set(), results: new Set() }),
        impact: () => ({ basis: 'test', providerSerialization: 'test', cacheHitTokens: null, beforeBytes: 3, afterBytes: 3, commonPrefixBytes: 0, firstChangedByte: 0, changedSuffixBytes: 3 }) } })
    assert.equal(result.request.messages[0].content[0].text, 'baz')
    assert.equal(request.messages[0].content[0].text, 'foo')
  })
})

test('async text plans release synchronous decision scopes before awaiting a Worker', async () => {
  const engine = createEngine({ rules: transforms('request.assemble', [{ findRegex: '/foo/', replaceString: 'bar' }]) })
  const b = block('foo', 'model'), request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'foo' }] }] }
  let active = false, batches = 0
  const { executeTextTransforms } = await import('../lib/text-transform-plan.js')
  const result = await planRequestAsync({ request, blocks: [b], rules: engine.rules(), events: engine.detect({ blocks: [b], stage: 'request.assemble' }), templates, snapshot: {},
    decision() { throw new Error('decision-outside-synchronous-scope') },
    withDecisions(run) { active = true; batches++; try { const result = run(() => { assert.equal(active, true); return { enabled: true } }); assert.equal(typeof result?.then, 'undefined'); return result } finally { active = false } },
    ports: { writeBlock: setRequestBlock, insertionMessage() { throw new Error('unexpected insertion') }, impact: requestImpact, pairs: indexRequestPairs } },
  async ({ textTransforms }) => { assert.equal(active, false); await Promise.resolve(); return executeTextTransforms(textTransforms) })
  assert.equal(result.request.messages[0].content[0].text, 'bar'); assert.equal(active, false); assert.equal(batches, 1)
})

test('deferred text commits share the Engine ledger and do not spend state before ACK', () => {
  const engine = createEngine(), definition = [{ id: 'r', order: 1, oncePerSurface: true, action: { kind: 'transform' },
    when: { findRegex: '/foo/', replaceString: 'bar' }, budget: { maxCacheLoss: 1 } }]
  const input = { key: 's', rules: definition, surface: { placement: 'request', text: 'foo' }, consumers: [{ name: 'x', kinds: ['transform'], handle() {} }] }
  const first = engine.prepare(input), abandoned = engine.prepare(input)
  assert.equal(first.result.text, 'bar'); assert.equal(abandoned.result.text, 'bar')
  first.commit()
  assert.throws(() => abandoned.commit(), /changed-before-commit/)
  assert.equal(engine.prepare(input).result.text, 'foo')
  assert.equal(engine.prepare({ ...input, key: 'other' }).result.text, 'bar')
})

test('real Tavern imports retain order, all macro modes, depth, edits and synchronous source text', () => {
  const imported = importTavernRegex([
    { id: 'first', placement: [1], markdownOnly: true, runOnEdit: true, minDepth: 1, maxDepth: 2, findRegex: '/({{who}}trim)/g', replaceString: '$1 {{suffix}}', substituteRegex: 2, trimStrings: ['trim'] },
    { id: 'second', placement: [1], markdownOnly: true, runOnEdit: true, minDepth: 1, maxDepth: 2, findRegex: '/done/g', replaceString: 'finished' },
  ], templates)
  assert.ok(imported.document); assert.equal(imported.report.filter(item => item.status === 'rejected').length, 0)
  const engine = createEngine({ rules: documentDeclarations([imported.document]) })
  const input = { ...block('a.btrim'), surface: { depth: 1, isEdit: true } }
  assert.equal(display(engine, [input], { who: 'a.b', suffix: 'done' }).after[0].text, 'a.b finished')
  assert.equal(display(engine, [{ ...input, surface: { depth: 0 } }], { who: 'a.b' }).after[0].text, 'a.btrim')
  const source = importTavernRegex([{ id: 'source', placement: [1], findRegex: '/foo/', replaceString: 'bar' }], templates)
  const sourceEngine = createEngine({ rules: documentDeclarations([source.document]) })
  sourceEngine.registerConsumer({ name: 'source', kinds: ['transform'], handle() {} })
  assert.equal(sourceEngine.run({ surface: { placement: 'user', text: 'foo' } }).text, 'bar')
})

test('baseline patches retain original coordinates while sequential text reads the accepted patch output', () => {
  const rules = transforms('display.render', [{ findRegex: '/foo/', replaceString: 'bar' }, { findRegex: '/bar!/', replaceString: 'baz' }])
  rules.push({ schemaVersion: 2, sourceId: 'patch', id: 'patch', revision: 1, priority: -1, on: ['display.render'],
    select: { view: 'display', roles: ['user'], blockTypes: ['text'] }, match: { kind: 'regex', field: 'block.text', pattern: '$', flags: '' },
    actions: [{ id: 'suffix', kind: 'replace', enabledDefault: true, stage: 'display.render', template: '!' }] })
  assert.equal(display(createEngine({ rules }), [block('foo')]).after[0].text, 'baz')
})

test('a skipped sequential parent never modifies dependent text or schedules its dependent effect', async () => {
  const rules = transforms('request.assemble', [{ findRegex: '/missing/', replaceString: 'bad' }])
  rules[0].actions.push({ ...rules[0].actions[0], id: 'child', dependsOn: ['rewrite'], transform: { findRegex: '/foo/', replaceString: 'wrong' } },
    { id: 'effect', kind: 'notify', enabledDefault: true, stage: 'request.assemble', dependsOn: ['child'], template: 'must not run' })
  const engine = createEngine({ rules }), b = block('foo', 'model'), request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'foo' }] }] }
  const { planRequest } = await import('../lib/index.js')
  const result = planRequest({ request, blocks: [b], rules: engine.rules(), events: engine.detect({ blocks: [b], stage: 'request.assemble' }), templates,
    snapshot: {}, decision: () => ({ enabled: true }), ports: { writeBlock: setRequestBlock, impact: requestImpact, pairs: indexRequestPairs, insertionMessage() { throw new Error('unused') } } })
  assert.equal(result.request.messages[0].content[0].text, 'foo')
  assert.equal(result.applied.length, 0); assert.equal(result.scheduled.length, 0)
})

test('execution phases reject direct and transitive dependencies on later effects', () => {
  for (const stage of ['request.assemble', 'display.render']) {
    const [rule] = transforms(stage, [{ findRegex: '/foo/', replaceString: 'bar' }])
    assert.throws(() => createEngine({ rules: [{ ...rule, actions: [...rule.actions,
      { id: 'late-edit', kind: 'replace', enabledDefault: true, stage, template: 'bad', dependsOn: ['rewrite'] }] }] }), /later execution phase/)
  }
  const [rule] = transforms('request.assemble', [{ findRegex: '/foo/', replaceString: 'bar' }])
  const effect = { id: 'effect', kind: 'notify', enabledDefault: true, stage: 'request.assemble', template: 'NOTICE', dependsOn: ['rewrite'] }
  assert.throws(() => createEngine({ rules: [{ ...rule, actions: [...rule.actions, effect,
    { ...rule.actions[0], id: 'late-text', dependsOn: ['effect'] }] }] }), /later execution phase/)
  assert.throws(() => createEngine({ rules: [{ ...rule, actions: [...rule.actions, effect,
    { id: 'late-edit', kind: 'inject', enabledDefault: true, stage: 'request.assemble', template: 'bad', dependsOn: ['effect'] }] }] }), /later execution phase/)
})

test('display Worker waits outside the control batch used to prepare the projection', async () => {
  const engine = createEngine({ rules: transforms('display.render', [{ findRegex: '/foo/', replaceString: 'bar' }]) }), blocks = [block('foo')]
  const { executeTextTransforms } = await import('../lib/text-transform-plan.js')
  let active = false
  const result = await engine.displayAsync({ blocks, templates, snapshot: {}, decision() { throw new Error('unscoped decision') },
    events: engine.detect({ blocks, stage: 'display.render' }), maxInjectedChars: 65536, maxBytes: 100000,
    withDecisions(run) { active = true; try { const prepared = run(() => ({ enabled: true })); assert.equal(typeof prepared?.then, 'undefined'); return prepared } finally { active = false } } },
  async ({ textTransforms }) => { assert.equal(active, false); return executeTextTransforms(textTransforms) })
  assert.equal(result.after[0].text, 'bar')
})

test('a skipped display transform blocks dependent transformations while unrelated edits remain', () => {
  const [rule] = transforms('display.render', [{ findRegex: '/missing/', replaceString: 'bad' }])
  rule.actions.push({ ...rule.actions[0], id: 'child', dependsOn: ['rewrite'], transform: { findRegex: '/foo/', replaceString: 'wrong' } },
    { ...rule.actions[0], id: 'independent', transform: { findRegex: '/foo/', replaceString: 'good' } })
  const result = display(createEngine({ rules: [rule] }), [block('foo')])
  assert.equal(result.after[0].text, 'good')
  assert.deepEqual(result.records.map(record => record.status), ['skipped', 'skipped', 'planned'])
})

test('bounded Worker executes request text and protects the Host from runaway regex or cancellation', async t => {
  const worker = createBoundedMatcher({ timeoutMs: 2000 })
  t.after(() => worker.close())
  const rules = transforms('request.assemble', [{ findRegex: '/foo/g', replaceString: 'bar' }, { findRegex: '/bar/g', replaceString: 'baz' }])
  const engine = createEngine({ rules }), b = block('foo', 'model'), request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'foo' }] }] }
  const plan = await planRequestAsync({ request, blocks: [b], rules: engine.rules(), events: engine.detect({ blocks: [b], stage: 'request.assemble' }), templates,
    snapshot: {}, decision: () => ({ enabled: true }), ports: { writeBlock: setRequestBlock, impact: requestImpact, pairs: indexRequestPairs, insertionMessage() { throw new Error('unused') } } },
    (task, signal) => worker.detect(task, signal))
  assert.equal(plan.request.messages[0].content[0].text, 'baz')
  const bad = createEngine({ rules: transforms('display.render', [{ findRegex: '/(a+)+$/', replaceString: 'x' }]) })
  const badBlock = block('a'.repeat(30000) + '!')
  await assert.rejects(bad.displayAsync({ blocks: [badBlock], events: bad.detect({ blocks: [badBlock], stage: 'display.render' }), templates, snapshot: {},
    decision: () => ({ enabled: true }), maxInjectedChars: 65536, maxBytes: 8388608 }, (task, signal) => worker.detect(task, signal)), /timeout/)
  const aborted = new AbortController(); aborted.abort(new Error('stop-text'))
  await assert.rejects(engine.displayAsync({ blocks: [], events: [], templates, snapshot: {}, decision: () => ({ enabled: true }), maxInjectedChars: 65536, maxBytes: 8388608 },
    (task, signal) => worker.detect(task, signal), aborted.signal), /stop-text/)
})
