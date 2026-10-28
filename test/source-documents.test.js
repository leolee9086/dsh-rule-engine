import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../lib/index.js'

const rule = (overrides = {}) => ({ schemaVersion: 2, id: 'notice', revision: 1, on: ['tool.succeeded'],
  select: { view: 'original', roles: ['tool'], blockTypes: ['tool-result'] }, event: { tool: 'read', arguments: { file_path: { regex: '\\.ts$' } } },
  match: { kind: 'always' }, actions: [{ id: 'model', kind: 'notify', stage: 'tool.succeeded', enabledDefault: true,
    template: 'explicit', delivery: { model: { once: 'surface' } } }], ...overrides })
const document = (id = 'note', declaration = rule(), body = 'BODY', rootId = 'root') => ({ id, rootId, title: 'Title',
  text: '```dsh-rule\n' + JSON.stringify(declaration) + '\n```\n\n' + body })

function fixture(t, rows = [document()], refreshMs = 60000) {
  const engine = createEngine(), errors = [], calls = [], state = { rows, keys: ['local'], offline: false, gate: undefined, changes: 0, stopped: false }
  const runtime = engine.events({ save() {}, saveCapacity() {}, changed() { state.changes++ }, sinceSeq: () => -1, report: error => errors.push(error) })
  let receive
  const sources = runtime.connectDocuments({ plugin: 'documents-test', refreshMs, keys: () => state.keys, sourceId: key => 'notes:' + key,
    accepts: (key, sessionId) => state.keys.includes(key) && sessionId === 'allowed', report: error => errors.push(error),
    async read(key, roots, signal) {
      assert.equal(key, 'local'); assert.ok(signal); calls.push(roots)
      const gate = state.gate; state.gate = undefined; if (gate) await gate()
      if (state.offline) throw new Error('io-offline')
      return state.rows.filter(row => !roots || roots.includes(row.rootId))
    },
    watch(listener) { receive = listener; listener({ key: 'local', kind: 'ready' }); return async () => { state.stopped = true } },
  })
  t.after(() => runtime.close())
  return { engine, runtime, sources, errors, calls, state, notify: event => receive({ key: 'local', ...event }),
    catalog: () => runtime.controlCatalog('allowed'), rules: () => engine.rules({ sessionId: 'allowed' }) }
}
const settle = async condition => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(condition(), 'document update did not settle')
}

test('documents use the canonical declaration and invalid siblings remain visible as diagnostics', async t => {
  const f = fixture(t, [document(), document('bad', rule({ unexpected: true })), { id: 'broken', rootId: 'root', text: 'missing fence' }])
  await f.sources.refresh()
  assert.equal(f.catalog()[0].rules.length, 1)
  assert.equal(f.rules()[0].id, 'note:notice'); assert.equal(f.rules()[0].actions[0].template, 'BODY')
  assert.equal(f.rules()[0].event.arguments.file_path.regex, '\\.ts$')
  assert.equal(f.runtime.snapshot('allowed').sources[0].diagnostics.length, 2)
  assert.ok(f.runtime.snapshot('allowed').sources[0].diagnostics.some(value => value.id === 'bad:notice' && value.message.includes('unexpected')))
  assert.ok(f.errors.some(error => String(error).includes('bad:notice') && String(error).includes('unexpected')))
  assert.deepEqual(f.engine.rules({ sessionId: 'other' }), [])
  const changes = f.state.changes
  await f.sources.refresh(); assert.equal(f.state.changes, changes, 'unchanged document cannot republish a snapshot')
  assert.equal(f.calls.length, 2)
})

test('document decoder rejects duplicate keys, aliases and obsolete formats through one boundary', async t => {
  const duplicate = { id: 'duplicate', rootId: 'root', text: '```dsh-rule\nid: first\nid: second\n```' }
  const old = document('old', { format: 'reminder/v4', id: 'old', on: 'request.before', when: {}, effect: { kind: 'remind' } })
  const recursive = { id: 'cycle', rootId: 'root', text: '```dsh-rule\n&root {id: cycle, actions: [], match: *root}\n```' }
  const f = fixture(t, [document(), duplicate, old, recursive])
  await f.sources.refresh()
  assert.equal(f.rules().length, 1); assert.equal(f.runtime.snapshot('allowed').sources[0].diagnostics.length, 3)
  assert.ok(f.runtime.snapshot('allowed').sources[0].diagnostics.some(value => value.message.includes('unique')))
})

test('real source registration compiles extensions once and reuses the same owned product across views', async t => {
  const engine = createEngine(), errors = []; let compilations = 0
  engine.extensions.registerCondition({ ref: 'test:ready', revision: 1, paramsSchema: true, compile() { compilations++; return { kind: 'always' } } })
  const runtime = engine.events({ save() {}, saveCapacity() {}, changed() {}, report: error => errors.push(error), sinceSeq: () => -1 })
  t.after(() => runtime.close())
  const declaration = { ...rule({ match: { kind: 'extension', ref: 'test:ready', revision: 1 } }), sourceId: 'source' }
  runtime.registerSource({ sourceId: 'source', plugin: 'test', revision: 1, rules: [declaration] })
  assert.equal(compilations, 1)
  for (let index = 0; index < 5; index++) {
    assert.equal(engine.rules()[0].match.kind, 'always'); assert.equal(runtime.controlCatalog('s')[0].rules.length, 1)
  }
  assert.equal(compilations, 1)
  const exposed = engine.rules(); exposed[0].actions[0].template = 'mutated'
  assert.equal(engine.rules()[0].actions[0].template, 'explicit')
  engine.extensions.registerCondition({ ref: 'test:ready', revision: 1, paramsSchema: true, compile() { compilations++; return { kind: 'keywords', values: ['NEW'] } } })
  assert.equal(compilations, 2); assert.equal(engine.rules()[0].match.kind, 'keywords'); assert.equal(compilations, 2)
  assert.deepEqual(errors, [])
})

test('source growth respects real capacity and retries cached documents without IO', async t => {
  const f = fixture(t, [document()], 25)
  await f.sources.refresh(); await f.runtime.setCapacity({ revision: 0, maxRules: 1 })
  f.state.rows.push(document('second'))
  await f.sources.refresh(); assert.equal(f.rules().length, 1)
  const calls = f.calls.length
  await f.runtime.setCapacity({ revision: 1, maxRules: 0 })
  await settle(() => f.rules().length === 2)
  assert.equal(f.calls.length, calls); assert.ok(f.errors.length > 0)
})

test('incremental document roots coalesce changes and remove deleted rules without polling IO', async t => {
  const f = fixture(t, [document()], 25)
  await f.sources.refresh(); const changes = f.state.changes
  await new Promise(resolve => setTimeout(resolve, 65)); assert.equal(f.calls.length, 1)
  f.notify({ kind: 'change', roots: ['unrelated'] })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.calls.length, 1)
  for (let index = 0; index < 10; index++) f.notify({ kind: 'change', roots: ['root'] })
  await settle(() => f.calls.length === 2); assert.equal(f.state.changes, changes)
  f.state.rows.push(document('second', rule(), 'SECOND', 'new-root'))
  f.notify({ kind: 'change', roots: ['new-root'], marker: true }); await settle(() => f.rules().length === 2)
  f.state.rows = f.state.rows.filter(row => row.rootId !== 'root')
  f.notify({ kind: 'change', roots: ['root'] }); await settle(() => f.rules().length === 1)
  assert.equal(f.rules()[0].actions[0].template, 'SECOND')
})

test('changes during a read survive and offline results cannot republish stale sources', async t => {
  const f = fixture(t); await f.sources.refresh()
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  f.state.gate = async () => { entered(); await gate }
  f.notify({ kind: 'change', roots: ['root'] }); await started
  f.notify({ kind: 'change', roots: ['root'] }); release()
  await settle(() => f.calls.length === 3)
  f.notify({ kind: 'offline' }); assert.deepEqual(f.engine.sources(), [])
  f.state.rows = [document('note', rule(), 'RECONNECTED')]; f.notify({ kind: 'ready' })
  await settle(() => f.rules().length === 1); assert.equal(f.rules()[0].actions[0].template, 'RECONNECTED')
  assert.equal(f.calls.at(-1), undefined)
  await f.runtime.close(); assert.equal(f.state.stopped, true); assert.deepEqual(f.engine.sources(), [])
  assert.throws(() => f.runtime.connectDocuments({}), /closed/)
})

test('document body does not change argument patches or synchronous text transforms', async t => {
  const f = fixture(t, [document('patch', rule({ on: ['tool.before-execute'], event: { tool: 'read' },
    actions: [{ id: 'patch', kind: 'replace', stage: 'tool.before-execute', enabledDefault: true, patch: { kind: 'tool-arguments', path: '/flag', value: true } }] })),
    document('transform', rule({ on: ['display.render'], event: undefined, select: { view: 'display', roles: ['assistant'], blockTypes: ['text'] },
      actions: [{ id: 'text', kind: 'transform', stage: 'display.render', enabledDefault: true, transform: { findRegex: '/a/', replaceString: 'b' } }] }))])
  await f.sources.refresh(); assert.equal(f.rules().length, 2)
  assert.equal(f.rules().find(value => value.id === 'patch:notice').actions[0].template, undefined)
  assert.equal(f.rules().find(value => value.id === 'transform:notice').actions[0].transform.replaceString, 'b')
})

test('large document snapshots retain unbounded source discovery and ordered updates', async t => {
  const f = fixture(t, Array.from({ length: 2000 }, (_, index) => document('note-' + String(index).padStart(4, '0'))))
  await f.sources.refresh(); assert.equal(f.rules().length, 2000); assert.equal(f.calls.length, 1)
  f.state.rows = [document('note-0000', rule(), 'UPDATED'), document('new')]
  await f.sources.refresh(); assert.equal(f.rules().length, 2); assert.equal(f.rules().find(value => value.id === 'note-0000:notice').actions[0].template, 'UPDATED')
  f.state.rows = []; await f.sources.refresh(); assert.deepEqual(f.rules(), [])
})
