import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, createExecutorRegistry, createRuleStore, createDocumentRegistry, createTemplates, createActionRuns, actionKey, decideRuntimeAction, createBoundedMatcher } from '../lib/index.js'
import { installExtension, extensionRule, installTriggerExtension, triggerRule } from './fixtures/rule-extension-package/index.js'

// These are engine environment ports, not a synthetic DSH Context. The tests
// verify common persistence and effect contracts independently of one Host.
const agent = { id: 's' }
const ports = { sessionId: value => value.id, active: () => true, deliver() {}, resume() {}, abort() {} }
const requestBlock = { id: 'b', view: 'model', role: 'user', type: 'text', text: 'MARK ready', seq: 2 }

test('independent extension source shares compilation, controls, cooldown, ACK and recovery with builtins', async t => {
  const engine = createEngine(), committed = new Map(), effects = []
  const executors = createExecutorRegistry({ available: () => true, execute: async input => { effects.push(input.inputs); return { value: input.inputs, content: [] } } })
  const dispose = installExtension(engine, executors)
  const store = createRuleStore({ save: async (id, value) => committed.set(id, value), compile: engine.compile })
  const templates = createTemplates()
  const document = { schemaVersion: 2, id: 'external', revision: 1, title: 'external', rules: [extensionRule()] }
  const registry = createDocumentRegistry({ templates, compile: engine.compile, sessionBoundaries: () => new Map(), documentSets: () => new Map() })
  registry.register({ plugin: 'example', registrationId: 'external', documents: [document] })
  await store.edit('s', { revision: 0, operation: 'put-document', document })
  assert.equal(registry.catalog('s', store.read('s').documents, () => ({ available: true, requires: [] }))[0].rules[0].actions[0].title, 'tool')
  const source = engine.provideRules('external', () => store.read('s').documents[0].rules)
  const event = engine.detect({ blocks: [requestBlock], stage: 'request.assemble' })[0], action = engine.rules()[0].actions[0]
  let enabled = true, now = 100
  const guard = (_id, event, action, captured) => decideRuntimeAction({ closed: false, storageAvailable: store.available('s'), current: () => captured === String(engine.token()),
    select: () => ({ enabled, reason: enabled ? undefined : 'disabled' }), runtime: () => store.read('s').runtime, event, action, turnId: 'turn', entry: () => undefined, now })
  const runs = createActionRuns({ store, registry: executors, templates, guard, ports, now: () => now })
  t.after(async () => { await runs.close(); registry.close(); dispose(); source(); await store.close(); executors.close() })
  const item = event => ({ event, action, context: { session: { turnId: 'turn' } }, inputs: { text: 'extension-result' } })
  enabled = false
  await runs.enqueue('s', [item(event)], String(engine.token())); await runs.drain(agent)
  assert.equal(effects.length, 0)
  enabled = true
  const next = { ...event, occurrenceId: 'fresh' }
  await runs.enqueue('s', [item(next)], String(engine.token())); await runs.drain(agent)
  assert.deepEqual(effects, [{ text: 'extension-result' }])
  const state = store.read('s').runtime.state[actionKey(next, action)]
  assert.equal(state.lastStarted, 100)
  assert.equal(guard('s', { ...next, occurrenceId: 'other' }, action, String(engine.token())).reason, 'cooldown')
  const restored = createRuleStore({ entries: [...committed], save: async () => {}, compile: engine.compile })
  assert.equal(restored.read('s').runtime.state[actionKey(next, action)].lastStarted, 100)
  await restored.close()
  now = 2000
  const pending = { ...next, occurrenceId: 'pending' }
  await runs.enqueue('s', [item(pending)], String(engine.token()))
  dispose()
  await runs.drain(agent)
  assert.equal(effects.length, 1, 'unloaded capability cannot start queued effects')
  assert.equal(store.read('s').runtime.runs.at(-1).status, 'skipped')
})

test('unloading an independent executor cancels its running port and retains an unknown outcome', async t => {
  let started
  const began = new Promise(resolve => { started = resolve })
  const engine = createEngine(), executors = createExecutorRegistry({ available: () => true, execute: input => new Promise((resolve, reject) => {
    started(input.signal); input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
  }) })
  const dispose = installExtension(engine, executors), store = createRuleStore({ save: async () => {} })
  const runs = createActionRuns({ store, registry: executors, templates: createTemplates(), guard: () => ({ enabled: true }), ports })
  t.after(async () => { await runs.close(); dispose(); await store.close(); executors.close() })
  engine.provideRules('external', () => [extensionRule()])
  const event = engine.detect({ blocks: [requestBlock], stage: 'request.assemble' })[0], action = engine.rules()[0].actions[0]
  await runs.enqueue('s', [{ event, action, inputs: { text: 'pending' }, context: { session: { turnId: 'turn' } } }], String(engine.token()))
  const drain = runs.drain(agent), signal = await began
  dispose()
  await drain
  assert.equal(signal.aborted, true)
  assert.equal(store.read('s').runtime.runs.at(-1).status, 'unknown')
})

test('independent trigger mappings share compiled conditions, source snapshots and owner withdrawal', async t => {
  const engine = createEngine(), matcher = createBoundedMatcher({ timeoutMs: 2000 }), errors = []
  let reads = 0
  const runtime = engine.events({ save() {}, saveCapacity() {}, changed() {}, report: error => errors.push(error), sinceSeq: () => -1,
    catalog: { names: new Set(['test/changed']), shapes: new Map([['test/changed', { kind: 'object', fields: { text: null }, index: null }]]) },
    resolveEvent: async event => { reads++; return { ...event, name: 'test/changed', arguments: { text: 'ready' }, clock: { at: 1000 } } },
    execute: (input, signal, timing) => matcher.detect(input, signal, timing) })
  const extension = installTriggerExtension(engine, runtime)
  t.after(async () => { extension.dispose(); await runtime.close(); await matcher.close() })
  const declaration = triggerRule(), owner = runtime.registerSource({ sourceId: 'example:events', plugin: 'example', revision: 1, rules: [declaration] })
  declaration.actions[0].params = 'mutated outside the registered snapshot'
  assert.equal(engine.rules()[0].actions[0].template, 'EVENT NOTICE')
  const publish = seq => runtime.publishCustomEvent({ sessionId: 's', name: 'example/changed', native: { type: 'session-event', seq }, facts: { text: 'blocked' } })
  assert.equal(runtime.handlesSessionEvent('test/changed'), true)
  await publish(1)
  // An unrelated capability cannot cancel a valid matched candidate.
  const unrelated = engine.extensions.registerCondition({ ref: 'other:condition', revision: 1, paramsSchema: true, compile: () => ({ kind: 'always' }) })
  const messages = await runtime.collect({ sessionId: 's', visible: [] })
  assert.equal(messages[0].content[0].text, 'EVENT NOTICE'); assert.equal(reads, 1)
  await publish(2)
  extension.stopTrigger()
  assert.deepEqual(await runtime.collect({ sessionId: 's', visible: [] }), [])
  assert.equal(runtime.handlesSessionEvent('test/changed'), false)
  await assert.rejects(publish(3), /未被声明/)
  const restoredTrigger = runtime.registerCustomEvents([{ name: 'example/changed', nativeEvent: 'test/changed' }])
  extension.stopTrigger()
  assert.equal(runtime.handlesSessionEvent('test/changed'), true, 'an old disposer cannot remove the new producer')
  await publish(4)
  assert.equal((await runtime.collect({ sessionId: 's', visible: [] }))[0].content[0].text, 'EVENT NOTICE')
  await owner.dispose(); restoredTrigger(); unrelated()
  assert.equal(engine.sources().length, 0)
  assert.equal(errors.length, 1, 'withdrawal reports the unavailable event binding once')
})

test('extension effect ACK failure and unknown outcomes use the same durable state instead of retrying a side effect', async t => {
  const engine = createEngine(), effects = []
  let failAck = true
  const executors = createExecutorRegistry({ available: () => true, execute: async input => { effects.push(input); throw Object.assign(new Error('effect-unconfirmed'), { outcomeUnconfirmed: true }) } })
  const dispose = installExtension(engine, executors)
  const store = createRuleStore({ save: async () => { if (failAck) throw new Error('ack-failed') } })
  const runs = createActionRuns({ store, registry: executors, templates: createTemplates(), guard: () => ({ enabled: true }), ports })
  t.after(async () => { await runs.close(); dispose(); await store.close(); executors.close() })
  engine.provideRules('external', () => [extensionRule()])
  const event = engine.detect({ blocks: [requestBlock], stage: 'request.assemble' })[0], action = engine.rules()[0].actions[0]
  const item = { event, action, inputs: { text: 'uncertain' }, context: { session: { turnId: 'turn' } } }
  await assert.rejects(runs.enqueue('s', [item], String(engine.token())), /storage-unavailable/)
  assert.equal(effects.length, 0)
  failAck = false
  await runs.enqueue('s', [item], String(engine.token())); await runs.drain(agent)
  assert.equal(effects.length, 1)
  assert.equal(store.read('s').runtime.runs.at(-1).status, 'unknown')
  await runs.enqueue('s', [item], String(engine.token())); await runs.drain(agent)
  assert.equal(effects.length, 1)
})
