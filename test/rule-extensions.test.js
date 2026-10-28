import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, createBoundedMatcher, matchConditionV2, normalizeCondition, validateDocument, documentDeclarations } from '../lib/index.js'

const declaration = (match, actions = [{ id: 'replace', kind: 'replace', enabledDefault: true, stage: 'display.render', template: 'replaced' }]) => ({
  schemaVersion: 2, sourceId: 'extension-test', id: 'rule', revision: 1, on: ['display.render'],
  select: { view: 'display', roles: ['assistant'], blockTypes: ['text'] }, match, actions,
})
const block = { id: 'b', path: '0', view: 'display', role: 'assistant', type: 'text', text: 'hello MARK', seq: 1 }

test('extension conditions and actions compile to the common serializable worker plan', async t => {
  const engine = createEngine(), matcher = createBoundedMatcher({ timeoutMs: 2000 })
  t.after(() => matcher.close())
  engine.extensions.registerCondition({ ref: 'test:contains', revision: 1, paramsSchema: { type: 'string' },
    compile: text => ({ kind: 'keywords', values: [text], mode: 'ANY' }) })
  engine.extensions.registerAction({ ref: 'test:redact', revision: 1, paramsSchema: { type: 'string' },
    compile: template => ({ kind: 'replace', template }) })
  const raw = declaration({ kind: 'all', conditions: [{ kind: 'extension', ref: 'test:contains', revision: 1, params: 'MARK' }, { kind: 'not', condition: { kind: 'keywords', values: ['blocked'], mode: 'ANY' } }] },
    [{ id: 'redact', kind: 'extension', ref: 'test:redact', revision: 1, params: 'hidden', stage: 'display.render', enabledDefault: true }])
  engine.provideRules('external', () => [raw])
  const rules = engine.rules()
  assert.equal(rules[0].actions[0].id, 'redact')
  assert.equal(rules[0].actions[0].kind, 'replace')
  assert.equal(rules[0].actions[0].template, 'hidden')
  const events = await matcher.detect({ rules, blocks: [block], stage: 'display.render' })
  assert.equal(events.length, 1)
  assert.throws(() => engine.compile(declaration({ kind: 'extension', ref: 'test:contains', revision: 1, params: 42 })), /invalid-params/)
  assert.equal(engine.detect({ blocks: [{ ...block, text: 'MARK blocked' }], stage: 'display.render' }).length, 0)
})

test('document entries and ordinary rules resolve conditions through the same extension compiler', () => {
  const engine = createEngine()
  const off = engine.extensions.registerCondition({ ref: 'test:ready', revision: 1, paramsSchema: true, compile: () => ({ kind: 'keywords', values: ['MARK'], mode: 'ANY' }) })
  const condition = { kind: 'extension', ref: 'test:ready', revision: 1 }
  const document = validateDocument({ schemaVersion: 2, id: 'entries', revision: 1, title: 'Entries', rules: [declaration(condition)],
    entries: [{ id: 'entry', revision: 1, title: 'Entry', enabledDefault: true, template: 'EXTRA', activation: { kind: 'condition', condition },
      select: { view: 'display', roles: ['assistant'], blockTypes: ['text'] }, target: { view: 'display', anchor: 'end' } }] }, undefined, engine.compile)
  engine.provideRules('documents', () => documentDeclarations([document], engine.compile))
  assert.equal(engine.detect({ blocks: [block], stage: 'display.render' }).length, 2)
  off()
  assert.throws(() => engine.rules(), /extension-unavailable/)
})

test('replacement and unload invalidate plans; an old disposer cannot remove the new owner', () => {
  const engine = createEngine(), versions = []
  const stop = engine.observeCapabilities(() => versions.push(engine.token()))
  const register = pattern => engine.extensions.registerCondition({ ref: 'test:contains', revision: 1, paramsSchema: true,
    compile: () => ({ kind: 'keywords', values: [pattern], mode: 'ANY' }) })
  const old = register('MARK')
  engine.provideRules('external', () => [declaration({ kind: 'extension', ref: 'test:contains', revision: 1 })])
  const original = engine.token()
  assert.equal(engine.detect({ blocks: [block], stage: 'display.render' }).length, 1)
  const current = register('different')
  assert.ok(engine.token() > original)
  old()
  assert.equal(engine.detect({ blocks: [block], stage: 'display.render' }).length, 0)
  current()
  assert.throws(() => engine.rules(), /extension-unavailable/)
  assert.equal(versions.length, 3)
  stop()
})

test('fact conditions retain v1 null/undefined and ordered tool history semantics in block and event plans', () => {
  assert.equal(matchConditionV2(normalizeCondition({ kind: 'numbers', values: { pressure: { gte: 3 } } }), { pressure: null }).ok, false)
  assert.throws(() => matchConditionV2(normalizeCondition({ kind: 'numbers', values: { pressure: { gte: 3 } } }), {}), /finite number/)
  assert.equal(matchConditionV2(normalizeCondition({ kind: 'idle', since: 'save', minutes: 1 }), { now: 100000, toolCalls: [] }).ok, false)
  assert.equal(matchConditionV2(normalizeCondition({ kind: 'arguments', field: 'tool.arguments', contains: { path: ['src', '.ts'] } }), { tool: { arguments: { path: 'src/main.ts' } } }).ok, true)
})

test('event extensions are withdrawn before pending candidates or worker results can be delivered', async t => {
  const engine = createEngine(), matcher = createBoundedMatcher({ timeoutMs: 2000 }), errors = []
  const off = engine.extensions.registerCondition({ ref: 'test:ready', revision: 1, paramsSchema: true, compile: () => ({ kind: 'always' }) })
  const runtime = engine.events({ save() {}, saveCapacity() {}, changed() {}, report: error => errors.push(error), sinceSeq: () => -1,
    execute: (work, signal, timing) => matcher.detect(work, signal, timing) })
  t.after(async () => { await runtime.close(); await matcher.close() })
  runtime.registerSource({ sourceId: 'event-extension', plugin: 'test', revision: 1, rules: [{ schemaVersion: 2, sourceId: 'event-extension', id: 'notice', revision: 1,
    on: ['tool.succeeded'], event: { tool: 'probe' }, select: { view: 'original', roles: ['tool'], blockTypes: ['tool-result'] },
    match: { kind: 'extension', ref: 'test:ready', revision: 1 }, actions: [{ id: 'model', kind: 'notify', stage: 'tool.succeeded', enabledDefault: true,
      template: 'NOTICE', delivery: { model: { once: 'surface' } } }] }] })
  await runtime.submit({ sessionId: 's', name: 'probe', callId: 'call', rootCallId: 'call' })
  off()
  assert.deepEqual(await runtime.collect({ sessionId: 's', visible: [] }), [])
  assert.equal(errors.length, 1)
})

test('synchronous text can compose the same extension condition and keeps its synchronous result', () => {
  const engine = createEngine(), register = threshold => engine.extensions.registerCondition({ ref: 'example:load', revision: 1, paramsSchema: true,
    compile: () => ({ kind: 'numbers', values: { load: { gte: threshold } } }) })
  register(2)
  engine.provideRules('text-extension', () => [{ id: 'text', order: 0, when: { condition: { kind: 'all', conditions: [
    { kind: 'extension', ref: 'example:load', revision: 1 }, { kind: 'keywords', values: ['foo'], mode: 'ALL' } ] }, findRegex: '/foo/', replaceString: 'bar' },
    action: { kind: 'transform' }, budget: { maxCacheLoss: 1 } }])
  engine.registerConsumer({ name: 'text', kinds: ['transform'], handle() {} })
  assert.equal(engine.run({ surface: { placement: 'request', text: 'foo' }, ctx: { load: 1 } }).text, 'foo')
  assert.equal(engine.run({ surface: { placement: 'request', text: 'foo' }, ctx: { load: 2 } }).text, 'bar')
  const planned = engine.prepare({ surface: { placement: 'request', text: 'foo' }, ctx: { load: 2 } })
  register(3)
  assert.throws(() => planned.commit(), /changed-before-commit/)
})

test('text plans retain only capabilities they actually reference', () => {
  const engine = createEngine(), off = engine.extensions.registerCondition({ ref: 'used:condition', revision: 1, paramsSchema: true, compile: () => ({ kind: 'always' }) })
  engine.provideRules('text', () => [{ id: 'text', order: 0, when: { condition: { kind: 'extension', ref: 'used:condition', revision: 1 }, findRegex: '/foo/', replaceString: 'bar' },
    action: { kind: 'transform' }, budget: { maxCacheLoss: 1 } }])
  engine.registerConsumer({ name: 'text', kinds: ['transform'], handle() {} })
  const plan = engine.prepare({ surface: { placement: 'request', text: 'foo' } })
  const unused = engine.extensions.registerCondition({ ref: 'other:condition', revision: 1, paramsSchema: true, compile: () => ({ kind: 'always' }) })
  unused()
  assert.equal(plan.commit().text, 'bar')
  const stale = engine.prepare({ surface: { placement: 'request', text: 'foo' } })
  off()
  assert.throws(() => stale.commit(), /changed-before-commit/)
})

test('native snooze cannot be enabled by omitting the delivery reader', async t => {
  const engine = createEngine(), runtime = engine.events({ sessionAuthoritative: true, saveCapacity() {}, changed() {}, report() {}, sinceSeq: () => -1 })
  t.after(() => runtime.close())
  await assert.rejects(runtime.snooze({ sessionId: 's' }), /requires-native-tool-result/)
})
