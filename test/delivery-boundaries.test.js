import test from 'node:test'
import assert from 'node:assert/strict'
import { createClaimRuntime, emptyDeliveryProjection, emptyQueuedDeliveryProjection, applyDeliveryFact,
  applyQueuedDeliveryFact, queuedDeliveryMessages, planDeliveryInputs, collectDeliveryInputs, filterDeliveryMessages,
  handoffQueuedDelivery, createSnoozeResult, readSnoozeResult, SnoozeResult, snoozeResultSchema } from '../lib/index.js'

const queued = id => ({ id, role: 'user', content: [{ type: 'text', text: id }], source: {
  kind: 'plugin:dsh-context-care:reminder', summary: id,
  reminder: { key: id, candidateId: id, sessionId: 's', handoff: { queued: true }, shared: { key: 'shared' } },
  contextCareTrace: { sourceId: 'source', ruleId: id, callId: id, evidence: {},
    rule: { actions: [{ id: 'model', stage: 'tool.succeeded', delivery: { model: { once: 'surface' } } }] } },
} })
const user = { id: 'human', role: 'user', source: { kind: 'user' } }
const splice = (seq, inserted, start = 0, removedCount = 0, outcome) => ({ type: 'agent/inbox/spliced', seq,
  data: { target: 'next-turn', inserted, start, removedCount, ...(outcome ? { outcome } : {}) } })
const noSnooze = { snoozeTool: 'reminder_snooze', readSnooze: () => undefined }

function cache() {
  const values = new Map()
  return {
    define: (name, validity, create) => ({ name, validity, create }),
    use(owner, key, dependencies = []) {
      let own = values.get(owner)
      if (!own) { own = new Map(); values.set(owner, own) }
      if (!own.has(key)) own.set(key, key.create(owner, dependencies))
      return own.get(key)
    },
    clear(key) { for (const own of values.values()) own.delete(key) },
    worked() {},
  }
}

test('full and lightweight queued folds agree through inherited inputs, acceptance, commit and cancellation', () => {
  const inherited = queued('inherited'), first = queued('first'), second = queued('second')
  const full = emptyDeliveryProjection(2), light = emptyQueuedDeliveryProjection(2)
  for (const event of [splice(0, [inherited]), splice(1, [], 0, 1), splice(2, [first, user]), splice(3, [], 0, 2),
    splice(4, [second]), splice(5, [], 0, 1, 'canceled'), { type: 'user/message', seq: 6, data: first }]) {
    applyDeliveryFact(full, 's', event, noSnooze)
    applyQueuedDeliveryFact(light, 's', event)
    assert.deepEqual(light.queued, full.queued)
    assert.deepEqual(light.inbox, full.inbox)
    assert.equal(light.cursor, full.cursor)
  }
  assert.deepEqual([...light.queued.values()], [])
  applyQueuedDeliveryFact(light, 's', splice(5, [second]))
  assert.equal(light.queued.size, 0, 'an old observation cannot resurrect canceled input')
  const messages = queuedDeliveryMessages('s', new Map([['first', first]]), [first, { ...second, source: { kind: 'other' } }])
  assert.equal(messages.length, 1)
  messages[0].content[0].text = 'changed'
  assert.equal(first.content[0].text, 'first', 'the result cannot mutate native inbox facts')
})

test('delivery input plan preserves ordinary identity and position while replacing only admitted queued messages', async () => {
  const pending = queued('pending'), held = queued('held'), replacement = { ...pending, content: [{ type: 'text', text: 'frozen' }] }
  const appended = queued('new'), accepted = [user, pending, held]
  assert.deepEqual(planDeliveryInputs(accepted), [user])
  const calls = []
  const result = await collectDeliveryInputs({
    async prepareRequest(input) { calls.push(['prepare', input.accepted]) },
    async collect(input) { calls.push(['collect', input.accepted]); return [replacement, appended] },
  }, { sessionId: 's', events: { length: 0, at() {} }, visible: [], accepted })
  assert.deepEqual(calls, [['prepare', accepted], ['collect', accepted]])
  assert.deepEqual(result, [user, replacement, appended])
  assert.equal(result[0], user)
  assert.deepEqual(accepted, [user, pending, held])
})

test('queued handoff rechecks a policy changed during rollback and publishes no stale message', async () => {
  const first = queued('a'), second = queued('b'), published = [], rolledBack = [], visible = []
  let checks = 0
  await handoffQueuedDelivery({ sessionId: 's', candidateIds: ['a', 'b'], visible: () => visible, publish: message => published.push(message),
    runtime: {
      async queuePending(input) { assert.equal(input.visible, visible); return [first, second] },
      async filterMessages() { return ++checks === 1 ? [first] : [] },
      async rollback(_id, messages) { rolledBack.push(messages) },
    },
  })
  assert.deepEqual(rolledBack, [[second], [first]])
  assert.deepEqual(published, [])
})

test('final delivery filtering repeats after every rollback until its current result is stable', async () => {
  const first = queued('a'), second = queued('b'), rolledBack = [], errors = []
  let checks = 0
  const failure = new Error('native rollback failed')
  const result = await filterDeliveryMessages({ sessionId: 's', messages: [first, second], visible: () => [], onRollbackError: error => errors.push(error),
    runtime: {
      async filterMessages() { return ++checks === 1 ? [first] : [] },
      async rollback(_id, messages) { rolledBack.push(messages); if (messages.includes(second)) throw failure },
    },
  })
  assert.deepEqual(result, [])
  assert.equal(checks, 3)
  assert.deepEqual(rolledBack, [[second], [first]])
  assert.deepEqual(errors, [failure])
})

test('final filtering commits synchronously before a caller continuation can change the policy', async () => {
  const message = queued('ready'), order = []
  const promise = filterDeliveryMessages({ sessionId: 's', messages: [message], visible: () => [],
    runtime: { async filterMessages(_id, _visible, messages) { order.push('check'); return messages }, async rollback() { assert.fail('no rollback') } },
    commit(messages) { order.push('commit'); assert.equal(messages[0], message); return 'native decision' },
  })
  promise.then(() => order.push('caller'))
  assert.equal(await promise, 'native decision')
  assert.deepEqual(order, ['check', 'commit', 'caller'])
})

test('claim coordinator releases only canceled reservations and preserves real consumption across sessions', async t => {
  const session = {}, inbox = [], first = queued('first'), second = queued('second')
  const runtime = createClaimRuntime({ cache: cache(), now: () => 100, getSession: () => session, inbox: () => inbox,
    listSessions: async () => ['s'], read: async () => ({ length: 0, *select() {}, prepare: () => session, [Symbol.dispose]() {} }),
  })
  t.after(() => runtime.close())
  await runtime.update(book => book)
  inbox.push(first)
  runtime.observe('s', session, splice(0, [first]))
  assert.equal((await runtime.update(book => book)).buckets[0].claims[0].status, 'reserved')
  inbox.length = 0
  runtime.observe('s', session, splice(1, [], 0, 1, 'canceled'))
  assert.deepEqual(await runtime.update(book => book), { buckets: [] })
  inbox.push(second)
  runtime.observe('s', session, splice(2, [second]))
  runtime.observe('s', session, { type: 'user/message', seq: 3, data: second })
  inbox.length = 0
  runtime.observe('s', session, splice(4, [], 0, 1, 'canceled'))
  const committed = await runtime.update(book => book)
  assert.equal(committed.buckets[0].claims[0].status, 'consumed')
  await assert.rejects(runtime.update(book => { book.buckets[0].claims.push({ candidateId: 'fake', sessionId: 'other', messageId: 'fake', status: 'consumed' }); return book }), /delivery-not-committed/)
  assert.deepEqual(await runtime.update(book => book), committed, 'a failed transition publishes no poisoned copy')
})

test('snooze domain facts retain exact windows without interpreting prose or executing historical rules', () => {
  const windows = [{ sourceId: 'a', ruleId: 'b', key: 'night', until: 200 }]
  const fact = createSnoozeResult('s', windows, 'native presentation')
  assert.deepEqual(SnoozeResult.parse(fact), fact)
  assert.deepEqual(readSnoozeResult([{ type: 'text', text: JSON.stringify(fact) }], undefined), fact)
  assert.equal(readSnoozeResult([{ type: 'text', text: 'paused all reminders' }], undefined), undefined)
  assert.deepEqual(snoozeResultSchema.required, ['format', 'sessionId', 'summary', 'windows'])
})
