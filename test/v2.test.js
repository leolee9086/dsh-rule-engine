import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRuleV2, detectRulesV2, applyBlockPatchesV2, bindInputs, selectBlocksV2 } from '../lib/index.js'
const rule = (match, options = {}) => normalizeRuleV2({ schemaVersion: 2, sourceId: 'external', id: 'r', revision: 1, on: ['request.assemble'],
  select: { view: 'model', roles: ['assistant'], blockTypes: ['text'] }, match,
  actions: [{ id: 'notice', kind: 'notify', enabledDefault: false, stage: 'request.assemble', template: '{{captures.name}}' },
    { id: 'replace', kind: 'replace', enabledDefault: true, stage: 'request.assemble', template: 'fixed' }], ...options })
const block = (id, text, extra = {}) => ({ id, text, raw: { type: 'text', text }, type: 'text', view: 'model', sessionId: 's', seq: 4,
  messageId: id, turnId: 'turn:2', role: 'assistant', ...extra })
test('one UTF16 occurrence preserves named captures for both independent actions', () => {
  const events = detectRulesV2({ rules: [rule({ kind: 'regex', pattern: '(?<name>foo)' })], blocks: [block('b', '🧵foo')], stage: 'request.assemble' })
  assert.equal(events.length, 1); assert.deepEqual(events[0].ranges, [[2, 5]]); assert.equal(events[0].captures.name, 'foo')
  assert.deepEqual(events[0].sourceSeqs, [4])
})
test('message depth counts messages before selecting assistant blocks', () => {
  const blocks = [block('a', 'old'), block('b', 'new', { role: 'user' })]
  assert.deepEqual(selectBlocksV2(blocks, { view: 'model', roles: ['assistant'], blockTypes: ['text'], depth: { unit: 'message', limit: 1 } }), [])
})
test('boolean groups and secondary negative keywords retain evidence', () => {
  const r = rule({ kind: 'all', conditions: [{ kind: 'keywords', values: ['foo'], mode: 'ALL' }, { kind: 'keywords', values: ['blocked'], mode: 'NOT-ANY' }] })
  assert.equal(detectRulesV2({ rules: [r], blocks: [block('b', 'foo')], stage: 'request.assemble' }).length, 1)
  assert.equal(detectRulesV2({ rules: [r], blocks: [block('b', 'foo blocked')], stage: 'request.assemble' }).length, 0)
})
test('typed bindings retain argv boundaries and reject prototype and missing values', () => {
  const snapshot = { captures: { path: 'C:/test; $(oops)', count: 3 }, vars: { flag: false } }
  const inputs = bindInputs({ argv: ['fixed', { bind: 'captures.path' }], count: { bind: 'captures.count' }, flag: { bind: 'vars.flag' } }, snapshot)
  assert.deepEqual(inputs.argv, ['fixed', snapshot.captures.path]); assert.equal(inputs.count, 3); assert.equal(inputs.flag, false)
  assert.throws(() => bindInputs({ bind: 'captures.missing' }, snapshot), /missing binding/)
  assert.throws(() => bindInputs({ bind: '__proto__.x' }, snapshot), /forbidden/)
})
test('original offsets resolve overlapping replacements by priority, leaving raw evidence intact', () => {
  const b = block('b', 'abcdef')
  const result = applyBlockPatchesV2([b], [{ blockId: 'b', actionId: 'low', priority: 1, range: [2, 5], text: 'bad' },
    { blockId: 'b', actionId: 'high', priority: 2, range: [1, 3], text: 'X' }])
  assert.equal(result.blocks[0].text, 'aXdef'); assert.equal(b.raw.text, 'abcdef')
  assert.equal(result.results.find(value => value.actionId === 'low').reason, 'overlapping-patch')
  assert.throws(() => applyBlockPatchesV2([{ ...b, signed: true }], [{ blockId: 'b', actionId: 'x', priority: 0, range: [0, 1], text: '' }]), /cannot be text-patched/)
})
const joinedSelect = { view: 'model', roles: ['assistant'], blockTypes: ['text'], crossBlock: true, separator: '\n', depth: { unit: 'message', limit: 2 } }
test('fresh output matches across a history window and retains the original seqs', () => {
  const r = rule({ kind: 'regex', pattern: '(?<pair>old\\nnew)' }, { select: joinedSelect })
  const events = detectRulesV2({ rules: [r], blocks: [block('old', 'old', { seq: 3 }), block('new', 'new', { seq: 4 })], stage: 'request.assemble', freshSeq: 4 })
  assert.equal(events.length, 1); assert.equal(events[0].triggerSeq, 4)
  assert.deepEqual(events[0].sourceSeqs, [3, 4]); assert.equal(events[0].captures.pair, 'old\nnew')
  assert.equal(detectRulesV2({ rules: [r], blocks: [block('old', 'old', { seq: 3 }), block('new', 'new', { seq: 4 })], stage: 'request.assemble', freshSeq: 8 }).length, 0)
})
test('historical matches do not claim an exclusive group ahead of current output', () => {
  const old = rule({ kind: 'regex', pattern: 'old' }, { select: joinedSelect, id: 'old', priority: 20, exclusiveGroup: 'one' })
  const current = rule({ kind: 'regex', pattern: 'new' }, { select: joinedSelect, id: 'new', priority: 10, exclusiveGroup: 'one' })
  const blocks = [block('old', 'old', { seq: 3 }), block('new', 'new', { seq: 4 })]
  assert.deepEqual(detectRulesV2({ rules: [old, current], blocks, stage: 'request.assemble', freshSeq: 4 }).map(event => event.ruleId), ['new'])
})
test('repeated regex and keyword evidence selects the new occurrence instead of replaying the first', () => {
  for (const match of [{ kind: 'regex', pattern: '(?<value>foo)' }, { kind: 'keywords', values: ['foo'] }]) {
    const events = detectRulesV2({ rules: [rule(match, { select: joinedSelect })], blocks: [block('old', 'foo', { seq: 3 }), block('new', '🧵foo', { seq: 4 })], stage: 'request.assemble', freshSeq: 4 })
    assert.deepEqual(events[0].ranges, [[6, 9]])
  }
})
test('any conditions select current evidence even when an earlier branch matches history', () => {
  const r = rule({ kind: 'any', conditions: [{ kind: 'keywords', values: ['old'] }, { kind: 'regex', pattern: '(?<value>new)' }] }, { select: joinedSelect })
  const events = detectRulesV2({ rules: [r], blocks: [block('old', 'old', { seq: 3 }), block('new', 'new', { seq: 4 })], stage: 'request.assemble', freshSeq: 4 })
  assert.equal(events[0].captures.value, 'new'); assert.deepEqual(events[0].ranges, [[4, 7]])
})
test('zero width Unicode scans advance and can select a current output anchor', () => {
  const events = detectRulesV2({ rules: [rule({ kind: 'regex', pattern: '(?=.)', flags: 'u' }, { select: joinedSelect })], blocks: [block('old', '🧵', { seq: 3 }), block('new', 'x', { seq: 4 })], stage: 'request.assemble', freshSeq: 4 })
  assert.deepEqual(events[0].ranges, [[3, 3]])
})
test('Malformed action timing, targets, dependencies and structured inputs fail before they can enter a durable queue', () => {
  const base = { id: 'run', kind: 'program', executorRef: 'fixed', stage: 'request.assemble', enabledDefault: true }
  for (const change of [{ timeoutMs: 0 }, { timeoutMs: '100' }, { maxChars: -1 }, { dependsOn: [7] }, { dependsOn: ['run', 'run'] },
    { inputs: { bind: 'tool.__proto__' } }, { inputs: { bind: 'tool.name', extra: 1 } }, { inputs: { callback() {} } }, { inputs: { count: NaN } },
    { target: { view: 'model', anchor: 'depth' } }, { target: { view: 'model', depth: 3, anchor: 'end' } }, { target: { view: 'display', lifetime: 'forever' } }])
    assert.throws(() => rule({ kind: 'always' }, { actions: [{ ...base, ...change }] }), JSON.stringify(change))
  assert.throws(() => rule({ kind: 'always' }, { select: { view: 'model', roles: ['user'], blockTypes: ['text'], includeCurrent: 'false' } }))
  assert.throws(() => rule({ kind: 'always' }, { actions: [{ id: 'set', kind: 'set-variable', variable: 'x', stage: 'request.assemble', enabledDefault: true }] }), /value is required/)
  assert.throws(() => rule({ kind: 'keywords', values: ['x'], caseSensitive: 'false' }), /boolean/)
  assert.throws(() => rule({ kind: 'compare', field: 'vars.x', op: 'gt', value: '7' }), /number/)
  const cyclic = {}; cyclic.self = cyclic
  assert.throws(() => bindInputs(cyclic, {}), /acyclic/)
  assert.throws(() => bindInputs(new Date(), {}), /plain JSON/)
  assert.throws(() => bindInputs([, 1], {}), /dense/)
  const args = rule({ kind: 'always' }, { actions: [{ id: 'patch', kind: 'replace', stage: 'request.assemble', enabledDefault: true,
    patch: { kind: 'tool-arguments', path: '/count', value: { bind: 'vars.count' } } }] })
  assert.equal(args.actions[0].patch.path, '/count')
})

test('actions reject ignored fields, cross-stage dependencies and unpaired resume declarations', () => {
  const action = (id, kind, stage, extra = {}) => ({ id, kind, stage, enabledDefault: true, ...extra })
  const normalize = actions => rule({ kind: 'always' }, { on: ['request.assemble', 'output.complete'], actions })
  assert.throws(() => normalize([action('a', 'abort', 'request.assemble', { template: 'ignored' })]), /unknown abort action/)
  assert.throws(() => normalize([action('a', 'notify', 'request.assemble', { template: 'hello', executorRef: 'ignored' })]), /unknown notify action/)
  assert.throws(() => normalize([action('a', 'set-variable', 'request.assemble', { variable: 'n', value: 1, inputs: {} })]), /unknown set-variable action/)
  assert.throws(() => normalize([action('a', 'abort', 'request.assemble'), action('b', 'resume', 'output.complete', { template: 'continue', dependsOn: ['a'] })]), /same stage/)
  assert.throws(() => normalize([action('b', 'resume', 'request.assemble', { template: 'continue' })]), /abort dependency/)
  assert.throws(() => normalize([action('a', 'abort', 'request.assemble'), action('b', 'resume', 'request.assemble', { template: 'continue', dependsOn: ['a'], failurePolicy: 'continue' })]), /abort dependency/)
  assert.equal(normalize([action('a', 'abort', 'request.assemble'), action('b', 'resume', 'request.assemble', { template: 'continue', dependsOn: ['a'] })]).actions.length, 2)
})

test('cyclic and unknown dependencies fail at normalization', () => {
  assert.throws(() => rule({ kind: 'always' }, { actions: [{ id: 'a', kind: 'abort', stage: 'request.assemble', enabledDefault: true, dependsOn: ['a'] }] }), /cyclic/)
  assert.throws(() => rule({ kind: 'always' }, { unknown: true }), /unknown rule/)
})

test('all regex occurrences keep independent captures, Unicode zero widths and bounded evidence', () => {
  const detect = (match, text) => detectRulesV2({ rules: [rule(match)], blocks: [block('b', text)], stage: 'request.assemble' })
  const events = detect({ kind: 'regex', pattern: '(?<name>[ab])', all: true }, '🧵ab')
  assert.deepEqual(events.map(event => event.ranges), [[[2, 3]], [[3, 4]]])
  assert.deepEqual(events.map(event => event.captures.name), ['a', 'b'])
  assert.notEqual(events[0].occurrenceId, events[1].occurrenceId)
  assert.deepEqual(detect({ kind: 'regex', pattern: '(?=.)', flags: 'u', all: true }, '🧵a').map(event => event.ranges), [[[0, 0]], [[2, 2]]])
  assert.throws(() => detect({ kind: 'regex', pattern: 'a', all: true }, 'a'.repeat(1001)), /occurrence budget/)
  assert.throws(() => rule({ kind: 'not', condition: { kind: 'regex', pattern: 'a', all: true } }), /root condition/)
})

test('External evidence shares native priority, exclusive selection and current-output provenance', () => {
  const external = rule({ kind: 'detector', ref: 'plugin:detector', revision: 1 }, { priority: 20, exclusiveGroup: 'g' })
  const native = rule({ kind: 'regex', pattern: 'foo' }, { id: 'native', priority: 10, exclusiveGroup: 'g' })
  const evidence = { ok: true, ranges: [[2, 5]], captures: { value: 'foo' }, facts: { pattern: 'external' } }
  const detect = result => detectRulesV2({ rules: [native, external], blocks: [block('b', '🧵foo')], stage: 'request.assemble', freshSeq: 4, detectorMatch: () => result })
  const found = detect(evidence)
  assert.equal(found.length, 1); assert.equal(found[0].ruleId, 'r'); assert.equal(found[0].field, 'block.text')
  assert.deepEqual(found[0].facts, evidence.facts); assert.equal(found[0].triggerSeq, 4)
  assert.equal(detect({ ok: false, ranges: [], captures: {} })[0].ruleId, 'native')
  assert.equal(detect({ matches: [] })[0].ruleId, 'native')
  for (const invalid of [null, { matches: 'bad' }, { ...evidence, extra: 1 }, { ...evidence, ranges: [[0, 99]] }, { ...evidence, field: 'vars.value' }, { ...evidence, captures: [] }, { ...evidence, ok: 1 }]) assert.throws(() => detect(invalid), /detector|must be/)
  assert.throws(() => rule({ kind: 'not', condition: { kind: 'detector', ref: 'x', revision: 1 } }), /root condition/)
  assert.throws(() => detectRulesV2({ rules: [external], blocks: [block('b', 'foo')], stage: 'request.assemble' }), /detector unavailable/)
})
