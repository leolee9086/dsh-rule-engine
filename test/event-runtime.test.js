import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, quotaFor, recordDeliveryClaim, emptyDeliveryProjection, applyDeliveryFact, deliveryHanded } from '../lib/index.js'

// Fixtures use the public engine declaration directly. Every caller supplies the
// action and event fields it exercises; no retired reminder format is accepted.
export function eventRule(stage, { id = 'notice', ...fields } = {}, { template = 'NOTICE', delivery = { model: { once: 'surface' } }, ...action } = {}) {
  return { schemaVersion: 2, sourceId: 'test', revision: 1, id, on: [stage],
    select: { view: 'original', roles: ['tool', 'assistant', 'user'], blockTypes: ['tool-result', 'tool-call', 'text', 'reasoning'] },
    match: { kind: 'always' }, ...fields,
    actions: [{ id: 'model', kind: 'notify', stage, enabledDefault: true, template, delivery, ...action }],
  }
}
const execute = async input => ({ items: input.reminderBatch.rules.map(rule => ({ key: rule.key, ms: 0, match: { ok: true, status: 'matched', ranges: [], captures: {}, measurements: [], diagnostics: [] } })), stopped: false, elapsedMs: 0 })
const event = id => ({ sessionId: 's', name: 'probe', callId: id, rootCallId: id })

// These tests deliberately use process-local storage and observe every host port.
// Production construction has no implicit memory writer or discarded diagnostics.
function memoryPorts() {
  const states = new Map(), settings = [], changes = [], errors = []
  return { save: (id, state) => { states.set(id, structuredClone(state)) },
    saveCapacity: value => { settings.push(structuredClone(value)) },
    changed: id => { changes.push(id) }, report: error => { errors.push(error) }, sinceSeq: () => -1 }
}

test('one registry owns synchronous v1 and independent event actions, and disposes sources', async t => {
  const engine = createEngine({ rules: [{ id: 'v1', order: 1, action: { kind: 'notify', say: 'old' } }] })
  const runtime = engine.events({ ...memoryPorts(), execute }); t.after(() => runtime.close())
  const rule = eventRule('tool.succeeded', { event: { tool: 'probe' } }, { template: 'first' })
  rule.actions.push({ ...rule.actions[0], id: 'second', template: 'second' })
  const owner = runtime.registerSource({ sourceId: 'source', plugin: 'test', revision: 1, rules: [rule] })
  assert.equal(engine.rules().length, 2)
  assert.equal(engine.rules().find(rule => rule.id === 'notice').sourceId, 'source')
  await runtime.submit(event('one'))
  const messages = await runtime.collect({ sessionId: 's', visible: [] })
  assert.deepEqual(messages.map(message => message.content[0].text), ['first', 'second'])
  assert.equal(new Set(messages.map(message => message.source.reminder.key)).size, 2)
  assert.deepEqual(messages, JSON.parse(JSON.stringify(messages)), 'native Session must receive lossless JSON, including zero priority')
  await runtime.rollback('s', [messages[1]])
  await runtime.submit(event('two'))
  assert.deepEqual(await runtime.collect({ sessionId: 's', visible: [messages[0]] }).then(values => values.map(message => message.content[0].text)), ['second'])
  owner.dispose(); assert.deepEqual(engine.rules().map(rule => rule.id), ['v1'])
})

test('event actions honor defaults and live policy, and registry queries isolate sessions', async t => {
  let enabled = false
  const engine = createEngine(), runtime = engine.events({ ...memoryPorts(), execute, eligible: () => enabled }); t.after(() => runtime.close())
  const rule = eventRule('tool.succeeded', { event: { tool: 'probe' } }, { enabledDefault: false })
  const owner = runtime.registerSource({ sourceId: 'source', plugin: 'test', sessionId: 's', revision: 1, rules: [rule] })
  assert.equal(engine.rules({ sessionId: 's' }).length, 1)
  assert.deepEqual(engine.rules({ sessionId: 'other' }), [])
  await runtime.submit(event('disabled')); assert.deepEqual(await runtime.collect({ sessionId: 's', visible: [] }), [])
  enabled = true
  await runtime.submit(event('enabled')); assert.equal((await runtime.collect({ sessionId: 's', visible: [] })).length, 1)
  await owner.dispose(); assert.deepEqual(engine.rules(), [])
  const defaults = engine.events({ ...memoryPorts(), execute }); t.after(() => defaults.close())
  defaults.registerSource({ sourceId: 'defaults', plugin: 'test', revision: 1, rules: [rule] })
  await defaults.submit(event('default-disabled')); assert.deepEqual(await defaults.collect({ sessionId: 's', visible: [] }), [])
})

test('an exclusive winner matches once and executes its dependency-ordered actions independently', async t => {
  const batches = []
  const runtime = createEngine().events({ ...memoryPorts(), execute: async input => { batches.push(input.reminderBatch.rules); return execute(input) } }); t.after(() => runtime.close())
  const rule = eventRule('tool.succeeded', { event: { tool: 'probe' }, exclusiveGroup: 'choice', priority: 10 }, { template: 'first' })
  rule.actions.unshift({ ...rule.actions[0], id: 'dependent', template: 'dependent', dependsOn: ['model'] })
  const other = eventRule('tool.succeeded', { id: 'other', event: { tool: 'probe' }, exclusiveGroup: 'choice' }, { template: 'suppressed' })
  runtime.registerSource({ sourceId: 'source', plugin: 'test', revision: 1, rules: [rule, other] })
  await runtime.submit(event('exclusive'))
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 2, 'two rules, independent of the number of actions')
  const messages = await runtime.collect({ sessionId: 's', visible: [] })
  assert.deepEqual(messages.map(message => message.content[0].text), ['first', 'dependent'])
  assert.ok(messages.every(message => message.source.contextCareTrace.ruleId === 'notice'))
})

test('event cooldowns belong to actions and recover from handed facts without matching again', async t => {
  let at = 1000
  const engine = createEngine(), runtime = engine.events({ ...memoryPorts(), execute, wallNow: () => at }); t.after(() => runtime.close())
  const rule = eventRule('tool.succeeded', { event: { tool: 'probe' } }, { cooldownMs: 100, delivery: { model: { once: 'surface' } } })
  rule.actions.push({ ...rule.actions[0], id: 'second', cooldownMs: 200 })
  const source = { sourceId: 'cooldowns', plugin: 'test', revision: 1, rules: [rule] }
  runtime.registerSource(source)
  await runtime.submit(event('first')); const first = await runtime.collect({ sessionId: 's', visible: [] })
  await runtime.collect({ sessionId: 's', visible: first, committedIds: first.map(message => message.id) })
  at = 1099; await runtime.submit(event('early')); assert.deepEqual(await runtime.collect({ sessionId: 's', visible: [] }), [])
  const projection = emptyDeliveryProjection(0), ports = { snoozeTool: 'snooze', readSnooze: () => undefined }
  applyDeliveryFact(projection, 's', { seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: first } }, ports)
  let reads = 0
  const restored = engine.events({ ...memoryPorts(), execute, wallNow: () => at, readDeliveries: async () => { reads++; return { windows: [], stickies: [], ticked: new Set(), committedIds: new Set(), humanId: '', queued: [], actionStarts: projection.actionStarts } } })
  t.after(() => restored.close()); await runtime.close(); restored.registerSource(source)
  at = 1100; await restored.submit(event('boundary')); const next = await restored.collect({ sessionId: 's', visible: [] })
  assert.deepEqual(next.map(message => message.source.reminder.handoff.actionId), ['model'])
  await restored.collect({ sessionId: 's', visible: next, committedIds: next.map(message => message.id) })
  at = 1200; await restored.submit(event('later')); assert.deepEqual((await restored.collect({ sessionId: 's', visible: [] })).map(message => message.source.reminder.handoff.actionId), ['model', 'second'])
  assert.ok(reads > 0)
})

test('shared quota identities and native handoffs distinguish action while retaining released model facts', async t => {
  let ledger = { buckets: [] }
  const engine = createEngine(), runtime = engine.events({ ...memoryPorts(), execute, updateClaims: async change => (ledger = change(ledger)) }); t.after(() => runtime.close())
  const rule = eventRule('tool.succeeded', { event: { tool: 'probe' } }, { delivery: { model: { once: 'surface', shared: { reset: 'lifetime', lifetime: 'campaign', limit: 2 } } } })
  rule.actions.push({ ...rule.actions[0], id: 'second' })
  runtime.registerSource({ sourceId: 'source', plugin: 'test', revision: 1, rules: [rule] })
  await runtime.submit(event('call'))
  const messages = await runtime.collect({ sessionId: 's', visible: [] }), candidates = runtime.snapshot('s').candidates
  assert.equal(quotaFor(candidates[0]).key, JSON.stringify(['source', 'notice', 'lifetime', 'campaign']))
  assert.notEqual(quotaFor(candidates[0]).key, quotaFor(candidates[1]).key)
  const projection = emptyDeliveryProjection(0), ports = { snoozeTool: 'snooze', readSnooze: () => undefined }
  applyDeliveryFact(projection, 's', { seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [messages[0]] } }, ports)
  assert.equal(deliveryHanded(projection, 's', JSON.stringify(['tool.succeeded', 'call']), { sourceId: 'source', ruleId: 'notice', actionId: 'model' }), true)
  assert.equal(deliveryHanded(projection, 's', JSON.stringify(['tool.succeeded', 'call']), { sourceId: 'source', ruleId: 'notice', actionId: 'second' }), false)
  const book = { buckets: [] }, charged = new Set()
  recordDeliveryClaim(book, charged, 's', messages[0], 'consumed', 0)
  assert.equal(book.buckets[0].claims[0].status, 'consumed')
  const released = structuredClone(messages[0]); released.source.contextCareTrace.rule = { format: 'reminder/v3', on: 'tool.succeeded', when: {}, deliver: { model: { once: 'surface', shared: { reset: 'lifetime', lifetime: 'campaign', limit: 2 } } } }; delete released.source.reminder.shared; delete released.source.reminder.handoff
  const historic = { buckets: [] }; recordDeliveryClaim(historic, new Set(), 's', released, 'consumed', 0)
  assert.deepEqual(historic, book)
})
