import test from 'node:test'
import assert from 'node:assert/strict'
import { createNoticeChannel, createCompletionFeedback, createStreamNoticeActions, createStreamWatch,
  createNoticeRuleRuntime, createRequestRewriter, cleanMessages, resolveScopedPrompts, selectScopedPrompts } from '../lib/index.js'

// 本夹具只保存库定义的投影；输入是公开事实协议，不复写任何原生日志解释或决策。
function cachePort() {
  const rows = new Map()
  return {
    define: (name, validity, create) => ({ name, validity, create }),
    use(owner, key, dependencies = []) {
      let entries = rows.get(owner)
      if (!entries) { entries = new Map(); rows.set(owner, entries) }
      let entry = entries.get(key)
      if (!entry || dependencies.some((value, index) => value !== entry.dependencies[index])) {
        entry = { dependencies: [...dependencies], value: key.create(owner, dependencies) }; entries.set(key, entry)
      }
      return entry.value
    },
    invalidate(owner, key) { rows.get(owner)?.delete(key) },
    clear(key) { for (const values of rows.values()) values.delete(key) },
    worked() {},
  }
}

test('synchronous notice collection preserves per-session cooldown, native evidence and consumer validation', () => {
  const hits = [], runtime = createNoticeRuleRuntime({
    rulesFor: () => [{ id: 'remember', order: 1, placement: ['user'], when: { said: 'MEMORIZE' },
      action: { kind: 'notify', by: 'context-care', say: 'Keep this fact.' }, cooldownMinutes: 10, oncePerSurface: true }],
    onHit: record => hits.push(record), warn() {},
  })
  const input = { key: 's', sessionId: 's', text: 'MEMORIZE', assistantText: '', toolCalls: [], evidence: { sourceSeqs: [4] } }
  const first = runtime.collect(input)
  assert.equal(first[0].text, 'Keep this fact.')
  assert.deepEqual(first[0].trace.sourceSeqs, [4])
  assert.equal(first[0].trace.evaluationId, hits[0].evaluationId)
  assert.deepEqual(runtime.collect(input), [])
  assert.equal(runtime.collect({ ...input, key: 'other', sessionId: 'other' }).length, 1)
})

test('notice async control changes discard stale proposals without spending deduplication or cooldown', async () => {
  let epoch = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const channel = createNoticeChannel(), controls = { epoch: () => epoch, sinceSeq: () => 1 }
  channel.register('first', () => [{ id: 'one', text: 'original evidence', sourceSeqs: [2] }])
  const stop = channel.register('waiting', () => gate)
  const collecting = channel.collect({ agentId: 's' }, controls)
  await Promise.resolve()
  epoch++; release([])
  assert.deepEqual(await collecting, [])
  stop()
  assert.equal((await channel.collect({ agentId: 's' }, controls)).length, 1)
  assert.deepEqual(await channel.collect({ agentId: 's' }, controls), [])
  assert.equal((await channel.collect({ agentId: 'other' }, controls)).length, 1)
})

test('completion facts reconstruct unknown allowance, committed delivery and fork-local cooldown after cache loss', async () => {
  const route = { provider: 'p', model: 'm' }, facts = [
    { type: 'request/header', seq: 0, route: { ...route, temperature: 0.8 } },
    { type: 'assistant/message', seq: 1, time: 10, completed: true, received: true, text: ['DONE'] },
  ]
  const session = { id: 's', seq: 2, inheritedEventCount: 0 }, sessions = [session]
  const service = createCompletionFeedback({ cache: cachePort(), sessions: { get: id => sessions.find(value => value.id === id), list: () => sessions, flush() {} },
    facts(_session, fromSeq) { return { length: facts.length, *[Symbol.iterator]() { yield* facts.filter(event => event.seq >= fromSeq) }, [Symbol.dispose]() {} } },
    active: () => true, since: () => -1, cooldownMs: 300000, maxObservedChars: 100, maxDeliveries: 2, render: value => value.line })
  const segment = service.collect(session, route)[0]
  assert.equal(segment.text, 'DONE')
  assert.deepEqual(service.list()[0].route, route, 'completion notices retain only exact route identity, excluding native request settings')
  await service.reserve(session, [segment], 'preparing')
  assert.deepEqual(service.collect(session, route), [])
  await service.rollback(session, 'preparing')
  assert.deepEqual(service.collect(session, route), [segment])
  for (const callId of ['unknown-one', 'unknown-two']) {
    facts.push({ type: 'request/header', seq: facts.length, route, prompt: { callId, segments: [segment] } })
    facts.push({ type: 'assistant/attempt', seq: facts.length, time: 20, completed: false, received: false, text: [] })
    session.seq = facts.length
    service.clear()
    assert.equal(service.list()[0].status, 'delivery-unknown')
  }
  assert.equal(service.list()[0].deliveries, 2)
  assert.deepEqual(service.collect(session, route), [])
  const child = { id: 'child', seq: facts.length, inheritedEventCount: facts.length }
  sessions.push(child)
  assert.deepEqual(service.collect(child, route), [])
  facts.push({ type: 'assistant/message', seq: facts.length, time: 21, completed: true, received: true, text: ['DONE'] })
  child.seq = facts.length
  assert.equal(service.collect(child, route).length, 1, 'parent cooldown must not suppress child observation')
  const childSegment = service.collect(child, route)[0]
  facts.push({ type: 'request/header', seq: facts.length, route, prompt: { callId: 'delivered', segments: [childSegment] } })
  facts.push({ type: 'assistant/message', seq: facts.length, time: 22, completed: true, received: true, text: ['Continuing work.'] })
  child.seq = facts.length
  service.clear()
  assert.equal(service.list('child')[0].status, 'dispatched')
  assert.deepEqual(service.collect(child, route), [])
})

test('stream notice decisions retain one automatic continuation and independent human-input rearming', () => {
  const actions = [], agent = { id: 's' }, trigger = { id: 'line-repeat' }, hit = { kind: 'line-repeat' }
  const policy = createStreamNoticeActions({ key: value => value.id, epoch: () => 0, enabled: () => true, available: () => true,
    notice: () => actions.push('notice'), abort: () => actions.push('abort'), resume: ({ includeNotice }) => actions.push(`resume:${includeNotice}`) })
  policy.actions.notice({ agent, trigger, hit }); policy.actions.abort({ agent, trigger, hit }); policy.actions.resume({ agent, trigger, hit })
  assert.deepEqual(actions, ['abort', 'resume:true'])
  policy.actions.notice({ agent, trigger, hit }); policy.actions.abort({ agent, trigger, hit })
  assert.equal(policy.actions.resume({ agent, trigger, hit }), false)
  assert.deepEqual(actions, ['abort', 'resume:true', 'notice', 'abort'])
  policy.actions.notice({ agent, trigger, hit }); assert.equal(actions.length, 4)
  policy.humanInput(agent); policy.actions.notice({ agent, trigger, hit }); assert.equal(actions.at(-1), 'notice')
  // 原监视器仍决定动作顺序和实时控制；新状态不改变检测器自身的每轮边界。
  const observed = [], watcher = createStreamWatch({ triggers: [{ id: 'phrase', kind: 'phrase', phrases: ['needle'], actions: ['notice'] }],
    actions: { notice: () => observed.push('hit') } })
  watcher.observe(agent, { type: 'start' }); watcher.observe(agent, { type: 'chunk', chunk: { type: 'text-delta', text: 'needle' } })
  assert.deepEqual(observed, ['hit'])
})

test('request rewrite audit failure and control changes cannot consume once-per-body bookkeeping', async () => {
  let fail = true, revision = 0, flip = false
  const body = JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'before' }] }] })
  const rewrite = createRequestRewriter({ rules: () => [{ id: 'replace', order: 1, placement: ['request'], when: { findRegex: '/before/', replaceString: 'after' },
    action: { kind: 'transform', by: 'context-care' }, budget: { maxCacheLoss: 1 }, oncePerSurface: true }],
    onRecord() {}, revision: () => revision, blocksChanged: () => [{ hash: 'block', charsBefore: 6, charsAfter: 5 }],
    journal: { async record() { if (fail) throw new Error('ack-failed'); if (flip) revision++ } } })
  const input = { body, url: 'https://example.test/chat', scope: { sessionId: 's' } }
  await assert.rejects(rewrite(input), /ack-failed/)
  fail = false; flip = true
  await assert.rejects(rewrite(input), { code: 'CONTROL_CHANGED' })
  flip = false
  assert.match(await rewrite(input), /after/)
  assert.equal(await rewrite(input), undefined)
})

test('scoped prompt routing and loop cleanup preserve purpose isolation and immutable assistant history', () => {
  const rules = resolveScopedPrompts([{ ruleId: 'route', version: '1', provider: 'p', model: 'm', trigger: 'model-switch', text: '{boundModelLabel}' }])
  assert.deepEqual(selectScopedPrompts(rules, { provider: 'p', model: 'm' }), [])
  assert.equal(selectScopedPrompts(rules, { provider: 'p', model: 'm' }, { provider: 'p', model: 'old' })[0].text, 'p/m')
  assert.deepEqual(selectScopedPrompts(rules, { provider: 'p', model: 'm', purpose: 'compaction' }, { provider: 'p', model: 'old' }), [])
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: ['Retain this evidence.', ...Array(40).fill('repeat repeat repeat')].join('\n') }] }]
  const snapshot = structuredClone(messages), cleaned = cleanMessages(messages)
  assert.ok(cleaned.removedLines > 0)
  assert.deepEqual(messages, snapshot)
  assert.deepEqual(cleanMessages(cleaned.messages).messages, cleaned.messages)
})
