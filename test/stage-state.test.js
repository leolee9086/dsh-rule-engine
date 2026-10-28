import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDocument, documentDefinitions, detectRulesV2, planStage, planRequest, reserveDispatch, handoffDispatch,
  settleDispatch, dispatchItems, actionKey, createTemplates, createRuleStore, createDocumentRegistry } from '../lib/index.js'

const entryDocument = () => validateDocument({ schemaVersion: 2, id: 'entry-state', revision: 1, title: 'Entry state', entries: [{
  id: 'held', revision: 1, title: 'Held', enabledDefault: true, template: 'HELD', activation: { kind: 'keywords', keywords: ['ACTIVE'] },
  select: { view: 'model', roles: ['user'], blockTypes: ['text'] }, target: { view: 'model' }, lifetime: 'until-inactive',
}] })
const nativePorts = {
  writeBlock() { throw new Error('unexpected block write') }, insertionMessage: insertion => ({ role: insertion.role, content: [{ type: 'text', text: insertion.text }] }),
  impact: () => ({ basis: 'test', providerSerialization: 'test', cacheHitTokens: null, beforeBytes: 0, afterBytes: 0, commonPrefixBytes: 0, firstChangedByte: null, changedSuffixBytes: 0 }),
  pairs: () => ({ calls: new Set(), results: new Set() }),
}

test('entry deactivation keeps acknowledged JSON order for CAS and rejects a real intervening mutation', async () => {
  const document = entryDocument(), rules = documentDefinitions([document]), key = actionKey({ sourceId: rules[0].sourceId, ruleId: rules[0].id, ruleRevision: 1 }, rules[0].actions[0])
  // occurrenceId is appended by the native handoff after materialization. A parser
  // that reorders these keys creates a false conflict against the durable record.
  const previous = { lastStarted: 1, lastActivationAt: 1, turnId: 't1', materialization: { text: 'HELD', turnId: 't1', turn: 1, stickyUntilTurn: null }, occurrenceId: 'old' }
  const runtime = { runs: [], state: { [key]: structuredClone(previous) } }, request = { messages: [] }
  const templates = createTemplates()
  const planned = await planStage({ request, rules, documents: [document], blocks: [], stage: 'request.assemble',
    snapshot: { session: { id: 's', turnId: 't2' } }, token: 'same', turn: 2, detect: async input => detectRulesV2(input),
    enabled: values => [...values], runtime: () => structuredClone(runtime), current: () => true, project: () => [],
    withDecisions: run => run(() => ({ enabled: true })),
    plan: input => planRequest({ ...input, templates, ports: nativePorts, decision: () => ({ enabled: true }) }),
  })
  assert.equal(planned.entryTransitions.length, 1); assert.equal(planned.applied.length, 0)
  assert.equal(JSON.stringify(planned.entryPrevious[key]), JSON.stringify(previous))
  const changed = structuredClone(runtime); changed.state[key].lastStarted = 2
  assert.throws(() => reserveDispatch(changed, planned, 'bad'), /entry-state-changed-before-dispatch/)
  reserveDispatch(runtime, planned, 'call', 100)
  handoffDispatch(runtime, planned, 'call', () => [document], 101); settleDispatch(runtime, planned, 'call', 102)
  assert.equal(runtime.state[key].materialization, undefined); assert.equal(runtime.state[key].lastInactiveAt, 101)
  assert.equal(runtime.state[`$dispatch:${key}`].status, 'settled'); assert.equal(dispatchItems(planned).length, 1)
})

const ruleDocument = (revision = 1, ruleRevision = 1) => ({ schemaVersion: 2, id: 'file', revision, title: 'File', rules: [{
  schemaVersion: 2, sourceId: 'ignored', id: 'notice', revision: ruleRevision, on: ['output.complete'],
  select: { view: 'original', roles: ['assistant'], blockTypes: ['text'] }, match: { kind: 'always' },
  actions: [{ id: 'notice', kind: 'notify', stage: 'output.complete', enabledDefault: true, template: 'Notice' }],
}] })

test('document file reload publishes atomically, preserves unchanged admissions and recovers from revision rejection', async () => {
  let boundary = 10, loaded = [{ path: 'rules', document: ruleDocument() }]
  const registry = createDocumentRegistry({ sessionBoundaries: () => new Map([['s', boundary]]), documentSets: () => new Map(), loadFiles: async () => loaded })
  await registry.reloadFiles()
  const original = registry.externalDocuments('s'), runtime = { runs: [], state: {} }
  const admission = () => { const docs = registry.externalDocuments('s'), rules = documentDefinitions(docs); return registry.admissions('s', rules, docs, runtime, () => -1).get(rules[0]) }
  assert.equal(admission(), 10)
  boundary = 20; loaded = [{ path: 'rules', document: ruleDocument(2) }]; await registry.reloadFiles(); assert.equal(admission(), 10)
  loaded = [{ path: 'rules', document: { ...ruleDocument(2), title: 'Changed without revision' } }]
  await assert.rejects(registry.reloadFiles(), /document-needs-new-revision/)
  assert.ok(registry.failure()); assert.equal(registry.externalDocuments('s')[0].title, 'File')
  loaded = [{ path: 'rules', document: ruleDocument(3, 2) }]; await registry.reloadFiles()
  assert.equal(registry.failure(), undefined); assert.equal(admission(), 20)
  assert.equal(original[0].revision, 1, 'a previous cut remains unchanged')
  registry.close(); await assert.rejects(registry.reloadFiles(), /workbench-closed/)
})

test('runtime storage preserves arbitrary JSON facts while action recovery reads only owned records', async () => {
  const original = { revision: 0, runtimeRevision: 0, documents: [], variables: {}, runtime: {
    runs: [null, 'external', { diagnostic: ['untyped', 1] }, { id: 'native', status: 'succeeded', result: { value: 1 } }],
    state: { marker: 'unrelated', extension: { nested: [1, false, null] } },
  } }
  let saved
  const store = createRuleStore({ entries: [['s', original]], save: async (_id, value) => { saved = structuredClone(value) } })
  assert.deepEqual(store.read('s').runtime, original.runtime)
  await store.runtime('s', runtime => { runtime.state.newFact = 1 })
  assert.deepEqual(saved.runtime.runs, original.runtime.runs)
  assert.equal(store.read('s').runtime.state.marker, 'unrelated')
  await store.close()
})

test('scoped document sources collide only where recipients overlap and inspect pending storage ACKs', async () => {
  let release, writing
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { writing = resolve })
  const store = createRuleStore({ save: async () => { writing(); await gate } })
  const registry = createDocumentRegistry({ documentSets: store.documentSets, sessionBoundaries: () => new Map([['a', 5], ['b', 7]]) })
  const put = store.edit('a', { revision: 0, operation: 'put-document', document: ruleDocument() }); await started
  assert.equal(store.read('a').documents.length, 0)
  assert.throws(() => registry.register({ plugin: 'p', registrationId: 'collision', sessionId: 'a', documents: [ruleDocument()] }), /source-conflict/)
  const remove = registry.register({ plugin: 'p', registrationId: 'b', sessionId: 'b', documents: [ruleDocument()] })
  assert.equal(registry.externalDocuments('a').length, 0); assert.equal(registry.externalDocuments('b').length, 1)
  assert.throws(() => registry.register({ plugin: 'p', registrationId: 'global', documents: [ruleDocument()] }), /source-conflict/)
  release(); await put; remove(); assert.equal(registry.externalDocuments('b').length, 0)
  registry.close(); await store.close()
})
