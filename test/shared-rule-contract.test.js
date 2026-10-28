import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, validateDocument, documentDeclarations, documentDefinitions, createRuleControls, normalizeRule, normalizeRuleV2, normalizeEventRule, normalizeCondition, compileSnapshotCondition, normalizeScope, matchesScope, runRegexScript, createBlockPatchPlan, applyBlockPatchesV2 } from '../lib/index.js'

const declaration = () => ({ schemaVersion: 2, sourceId: 'test:shared', id: 'rule', revision: 1,
  on: ['request.assemble'], select: { view: 'model', roles: ['user'], blockTypes: ['text'] }, match: { kind: 'always' },
  actions: [{ id: 'replace', kind: 'replace', stage: 'request.assemble', enabledDefault: true, template: 'NEW' }] })

test('document ingestion and all registry reads reuse the same owned compiled product', async () => {
  const engine = createEngine(); let calls = 0
  const extension = () => engine.extensions.registerCondition({ ref: 'shared:ready', revision: 1, paramsSchema: true, compile() { calls++; return { kind: 'always' } } })
  const off = extension(), input = declaration(); input.match = { kind: 'extension', ref: 'shared:ready', revision: 1 }
  const document = validateDocument({ schemaVersion: 2, id: 'owned', revision: 1, title: 'Owned', rules: [input] }, undefined, engine.compile)
  assert.equal(calls, 1)
  engine.provideRules('owned', () => documentDeclarations([structuredClone(document)]))
  assert.equal(documentDefinitions([document], engine.compile)[0].match.kind, 'always')
  const first = engine.rules(); first[0].actions[0].template = 'outside'
  assert.equal(engine.rules()[0].actions[0].template, 'NEW'); assert.equal(calls, 1)
  const controls = createRuleControls({ save: async () => {}, compile: engine.compile })
  controls.registerProvider(() => [{ sourceId: first[0].sourceId, plugin: 'test', registration: 'test', executor: 'test', rules: [{ id: first[0].id, definition: engine.rules()[0], actions: [{ id: 'replace', defaultEnabled: true }] }] }])
  controls.catalog('s'); controls.catalog('s'); assert.equal(calls, 1)
  const unrelated = engine.extensions.registerCondition({ ref: 'unrelated:ready', revision: 1, paramsSchema: true, compile: () => ({ kind: 'always' }) })
  engine.rules(); assert.equal(calls, 1)
  off(); assert.throws(() => engine.rules(), /unavailable/); const replacement = extension()
  assert.equal(engine.rules().length, 1); assert.equal(calls, 2); engine.rules(); assert.equal(calls, 2)
  const changed = documentDeclarations([document])[0]; changed.priority = 'invalid'
  assert.throws(() => engine.compile(changed), /priority/)
  replacement(); unrelated(); await controls.close()
})

test('public normalization views produce the same owned rule and survive a second boundary', () => {
  assert.equal(normalizeEventRule, normalizeRuleV2)
  const input = declaration(), rule = normalizeRule(input, 0)
  assert.deepEqual(normalizeRuleV2(input), rule)
  assert.deepEqual(normalizeRule(rule, 0), rule)
  assert.equal(Object.is(rule.order, -0), false)
  input.select.roles.push('assistant'); input.actions[0].template = 'mutated'
  assert.deepEqual(rule.select.roles, ['user']); assert.equal(rule.actions[0].template, 'NEW')
})

test('schema failures retain nested field paths after structured clone and all entry views reject', () => {
  const input = declaration(); input.actions[0].maxChars = 'many'
  for (const normalize of [value => normalizeRule(value, 0), normalizeRuleV2, normalizeEventRule]) {
    assert.throws(() => normalize(input), error => {
      assert.match(structuredClone(error).message, /actions\.0\.maxChars/)
      assert.match(error.message, /finite number|number/)
      return true
    })
  }
  input.actions[0].maxChars = 8; input.actions[0].cooldownMs = Number.MAX_SAFE_INTEGER + 1
  assert.throws(() => normalizeRule(input, 0), /cooldownMs/)
})

test('fixed regex compilation is shared without evaluating macro-substituted patterns early', () => {
  const input = declaration()
  input.actions = [{ id: 'transform', kind: 'transform', stage: 'request.assemble', enabledDefault: true, transform: { findRegex: '/[/', replaceString: 'x' } }]
  for (const normalize of [value => normalizeRule(value, 0), normalizeRuleV2, normalizeEventRule]) assert.throws(() => normalize(input), /findRegex/)
  assert.throws(() => normalizeRule({ id: 'text', order: 0, action: { kind: 'transform' }, when: { findRegex: '/[/', replaceString: 'x' } }, 0), /findRegex/)
  input.actions[0].transform.substituteRegex = 1
  assert.equal(normalizeRuleV2(input).actions[0].transform.findRegex, '/[/')
})

test('shared schemas preserve relay error classes, missing-order priority and readable tree depth', () => {
  assert.throws(() => compileSnapshotCondition({ kind: 'always', typo: true }), error => error.constructor === Error && structuredClone(error).message.includes('condition'))
  assert.throws(() => normalizeRule({ id: 'broken' }, 0), /explicit order/)
  assert.throws(() => normalizeRule({ ...declaration(), format: 'reminder/v1' }, 0), /unknown field format/)
  let condition = { kind: 'compare', field: 'session.model', op: 'exists' }
  for (let i = 0; i < 18; i++) condition = { kind: 'not', condition }
  assert.throws(() => normalizeScope({ condition }), /depth/)
})

test('shared JSON ownership rejects accessors, cycles and sparse arrays before executing payloads', () => {
  const make = value => ({ ...declaration(), actions: [{ id: 'set', kind: 'set-variable', stage: 'request.assemble', enabledDefault: true, variable: 'value', value }] })
  let reads = 0
  const accessor = Object.defineProperty({}, 'hidden', { enumerable: true, get() { reads++; return 'secret' } })
  assert.throws(() => normalizeRule(make(accessor), 0), /JSON/); assert.equal(reads, 0)
  const cycle = {}; cycle.self = cycle
  assert.throws(() => normalizeRule(make(cycle), 0), /JSON/)
  assert.throws(() => normalizeRule(make(new Array(2)), 0), /dense array/)
  assert.throws(() => normalizeRule(make({ bind: 'event.__proto__.value' }), 0), /forbidden/)
})

test('old unknown-field policies keep warn, drop and explicit boolean behavior', () => {
  const input = { id: 'old', order: 0, action: { kind: 'notify', extra: 7 }, when: { custom: 'value' }, extra: true }
  assert.deepEqual(normalizeRule({ id: 'empty', order: 0, when: {}, action: { kind: 'notify' } }, 0).when, {})
  const warnings = []
  const kept = normalizeRule(input, 0, { unknownFields: 'warn', onUnknownField: message => warnings.push(message) })
  assert.equal(kept.when.custom, 'value'); assert.equal(kept.action.extra, 7); assert.equal(warnings.length, 3)
  const dropped = normalizeRule(input, 0, { unknownFields: 'drop' })
  assert.equal(Object.hasOwn(dropped.when, 'custom'), false); assert.equal(Object.hasOwn(dropped.action, 'extra'), false)
  assert.throws(() => normalizeRule({ ...input, enabled: null }, 0, { unknownFields: 'drop' }), /enabled/)
})

test('shared condition schema preserves unavailable count leaves and root-only detector and regex contracts', () => {
  assert.deepEqual(normalizeCondition({ kind: 'all', conditions: [] }), { kind: 'all', conditions: [] })
  for (const child of [{ kind: 'regex', pattern: '.', all: true }, { kind: 'detector', ref: 'test:detector', revision: 1 }]) {
    assert.throws(() => normalizeCondition({ kind: 'not', condition: child }), /root condition/)
  }
  assert.throws(() => normalizeCondition({ kind: 'compare', field: 'event.constructor', op: 'exists' }), /forbidden/)
})

test('incremental displacement restores a blocked patch while keeping immutable original coordinates', () => {
  const blocks = [{ id: 'b', text: '0123456789' }]
  const patch = (actionId, range, priority, text) => ({ blockId: 'b', actionId, range, priority, text })
  const plan = createBlockPatchPlan(blocks)
  assert.equal(plan.accept([patch('a', [2, 6], 1, 'X')]), true)
  assert.equal(plan.accept([patch('b', [0, 4], 0, 'B'), patch('b', [8, 9], 0, 'Y')]), true)
  assert.equal(plan.accept([patch('high', [4, 7], 3, 'C')]), true)
  assert.equal(plan.finish().blocks[0].text, 'BC7Y9')
  assert.deepEqual(plan.finish().results.map(value => [value.actionId, value.status]), [['high', 'planned'], ['a', 'skipped'], ['b', 'planned'], ['b', 'planned']])
  assert.equal(blocks[0].text, '0123456789')
  assert.equal(applyBlockPatchesV2(blocks, [patch('whole', [0, 10], 2, 'ALL'), patch('part', [0, 1], 1, 'P')]).blocks[0].text, 'ALL')
})

test('recipient predicates reuse boolean evaluation while retaining missing identity and node budgets', () => {
  const missing = { kind: 'compare', field: 'session.model', op: 'ne', value: 'old' }
  assert.equal(matchesScope({ sessionId: 's' }, normalizeScope({ condition: missing })), false)
  assert.equal(matchesScope({ sessionId: 's' }, normalizeScope({ condition: { kind: 'not', condition: missing } })), true)
  assert.equal(matchesScope({ sessionId: 's', model: 'new' }, normalizeScope({ condition: missing })), true)
  const leaf = { kind: 'compare', field: 'session.sessionId', op: 'exists' }
  const oversized = { kind: 'all', conditions: Array.from({ length: 3 }, () => ({ kind: 'any', conditions: Array.from({ length: 43 }, () => leaf) })) }
  assert.throws(() => normalizeScope({ condition: oversized }), /128 nodes/)
  assert.throws(() => normalizeScope({ condition: { kind: 'all', conditions: [] } }), /Too small/)
  assert.deepEqual(normalizeScope({ sessionIds: ['s', 's'] }), { sessionIds: ['s'] })
})

test('regex edits preserve Unicode zero-width advances, sticky behavior and left-to-right macro calls', () => {
  assert.equal(runRegexScript({ findRegex: '/(?:)/gu', replaceString: '|' }, '🙂a'), '|🙂|a|')
  assert.equal(runRegexScript({ findRegex: '/(?=.)/g', replaceString: '|' }, '🙂a'), '|\ud83d|\ude42|a')
  assert.equal(runRegexScript({ findRegex: '/a/y', replaceString: 'X' }, 'ba'), 'ba')
  assert.equal(runRegexScript({ findRegex: '/a/y', replaceString: 'X' }, 'ab'), 'Xb')
  let calls = 0
  assert.equal(runRegexScript({ findRegex: '/(a)/g', replaceString: '$1{{n}}' }, 'aa', {
    macros: text => text.includes('{{n}}') ? text.replace('{{n}}', String(++calls)) : text,
  }), 'a1a2')
  assert.equal(calls, 2)
})
