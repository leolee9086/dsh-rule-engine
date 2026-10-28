import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, createEventRuntime, createBoundedMatcher } from '../lib/index.js'

// In-memory state is intentional in this fixture; every write and notification is observable.
function environment() {
  const states = new Map(), capacities = [], changes = [], errors = []
  return { states, capacities, changes, errors, ports: {
    save: (id, state) => { states.set(id, structuredClone(state)) },
    saveCapacity: value => { capacities.push(structuredClone(value)) },
    changed: id => { changes.push(id) },
    report: error => { errors.push(error) }, sinceSeq: () => -1,
    resolveEvent: async input => structuredClone(input),
  } }
}
function source() {
  return { sourceId: 'ports', plugin: 'test', revision: 1, rules: [{
    schemaVersion: 2, sourceId: 'ports', id: 'notice', revision: 1,
    on: ['tool.succeeded'], event: { tool: 'probe' },
    select: { view: 'original', roles: ['tool'], blockTypes: ['tool-result'] },
    match: { kind: 'always' }, actions: [{ id: 'model', kind: 'notify', stage: 'tool.succeeded',
      enabledDefault: true, template: 'NOTICE', delivery: { model: { once: 'surface' } } }],
  }] }
}
const event = (callId, seq) => ({ sessionId: 's', name: 'probe', callId, rootCallId: callId,
  native: { type: 'tool-result', seq } })

const missingPorts = [
  ['save', 'reminder-save-unavailable'],
  ['saveCapacity', 'reminder-capacity-storage-unavailable'],
  ['changed', 'reminder-change-observer-unavailable'],
  ['report', 'reminder-error-reporter-unavailable'],
  ['sinceSeq', 'reminder-policy-boundary-unavailable'],
]
for (const [name, message] of missingPorts) {
  test(`missing ${name} fails before publishing any runtime state`, () => {
    for (const value of [undefined, null]) {
      const host = environment(), options = { ...host.ports, [name]: value }
      const engine = createEngine()
      assert.throws(() => createEventRuntime(options), { name: 'TypeError', message })
      assert.throws(() => engine.events(options), { name: 'TypeError', message })
      assert.deepEqual(engine.sources(), [])
      assert.equal(host.states.size, 0)
      assert.deepEqual(host.capacities, [])
      assert.deepEqual(host.changes, [])
      assert.deepEqual(host.errors, [])
      // Native recovery removes only the legacy state-writer requirement.
      if (name !== 'save') assert.throws(() => createEventRuntime({ ...options, sessionAuthoritative: true }), { name: 'TypeError', message })
    }
  })
}

test('session-authoritative runtime never invokes a legacy candidate writer', async t => {
  const host = environment()
  delete host.ports.save
  const matcher = createBoundedMatcher({ timeoutMs: 2000 })
  const runtime = createEngine().events({ ...host.ports, sessionAuthoritative: true,
    execute: (work, signal, timing) => matcher.detect(work, signal, timing) })
  t.after(async () => { await runtime.close(); await matcher.close() })
  const owner = runtime.registerSource(source())
  await runtime.submit(event('native', 1))
  assert.equal((await runtime.collect({ sessionId: 's', visible: [] })).length, 1)
  assert.equal(host.states.size, 0)
  await owner.dispose()
  assert.deepEqual(host.changes, [undefined, undefined])
})

test('capacity publishes and notifies only after its explicit writer acknowledges', async t => {
  const host = environment()
  let acknowledge
  const ack = new Promise(resolve => { acknowledge = resolve })
  const runtime = createEventRuntime({ ...host.ports, saveCapacity: async value => {
    host.capacities.push(value); await ack
  } })
  t.after(() => runtime.close())
  const pending = runtime.setCapacity({ revision: 0, maxRules: 7 })
  await Promise.resolve()
  assert.deepEqual(host.changes, [])
  acknowledge()
  assert.equal((await pending).revision, 1)
  assert.deepEqual(host.capacities, [{ revision: 1, maxRules: 7 }])
  assert.deepEqual(host.changes, [undefined])
  const failure = new Error('disk-full')
  const failed = createEventRuntime({ ...host.ports, saveCapacity: async () => { throw failure } })
  t.after(() => failed.close())
  await assert.rejects(failed.setCapacity({ revision: 0, maxRules: 9 }), error => error === failure)
  assert.deepEqual(host.changes, [undefined], 'failed capacity writes cannot notify observers')
})

test('explicit reset boundary excludes old native facts while preserving fresh delivery', async t => {
  const host = environment(), matcher = createBoundedMatcher({ timeoutMs: 2000 }), boundaries = []
  const runtime = createEventRuntime({ ...host.ports,
    sinceSeq: (...identity) => { boundaries.push(identity); return 4 },
    execute: (work, signal, timing) => matcher.detect(work, signal, timing) })
  t.after(async () => { await runtime.close(); await matcher.close() })
  runtime.registerSource(source())
  await runtime.submit(event('old', 4))
  assert.deepEqual(await runtime.collect({ sessionId: 's', visible: [] }), [])
  await runtime.submit(event('new', 5))
  assert.equal((await runtime.collect({ sessionId: 's', visible: [] })).length, 1)
  assert.ok(boundaries.length >= 2)
  assert.ok(boundaries.every(identity => JSON.stringify(identity) === JSON.stringify(['s', 'ports', 'notice'])))
  assert.ok(host.states.has('s'), 'standalone state reaches the supplied writer')
  assert.deepEqual(host.errors, [])
})
