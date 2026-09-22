import test from 'node:test'
import assert from 'node:assert/strict'
import { matchRule, matchArgs, matchIdle, matchText } from '../lib/match.js'
import { normalizeRule } from '../lib/rules.js'
import { PLACEMENT } from '../lib/placement.js'

/** 造一条规范化规则。 */
function rule(overrides = {}) {
  return normalizeRule({ id: 'r', order: 1, action: { kind: 'notify' }, ...overrides }, 0)
}

/** 造一个 surface。 */
function surface(overrides = {}) {
  return { placement: PLACEMENT.REASONING, text: 'x', ...overrides }
}

test('placement：规则声明的位置里没有当前位置就不跑；声明为空 = 哪都跑', () => {
  const scoped = rule({ placement: [PLACEMENT.REASONING] })
  assert.equal(matchRule(scoped, surface()).ok, true)
  assert.equal(matchRule(scoped, surface({ placement: PLACEMENT.USER })).reason, 'placement')
  assert.equal(matchRule(rule(), surface({ placement: PLACEMENT.TOOL_RESULT })).ok, true)
})

test('depth：只对最近 N 条生效；调用方没给就一律放行', () => {
  const r = rule({ depth: { min: 1, max: 3 } })
  assert.equal(matchRule(r, surface({ depth: 0 })).reason, 'depth')
  assert.equal(matchRule(r, surface({ depth: 2 })).ok, true)
  assert.equal(matchRule(r, surface({ depth: 9 })).reason, 'depth')
  assert.equal(matchRule(r, surface()).ok, true)
})

test('markdownOnly / promptOnly 是三态', () => {
  const displayOnly = rule({ markdownOnly: true })
  assert.equal(matchRule(displayOnly, surface({ isMarkdown: true })).ok, true)
  assert.equal(matchRule(displayOnly, surface({ isPrompt: true })).reason, 'target')
  const promptOnly = rule({ promptOnly: true })
  assert.equal(matchRule(promptOnly, surface({ isPrompt: true })).ok, true)
  assert.equal(matchRule(promptOnly, surface({ isMarkdown: true })).reason, 'target')
  // 两个都不是的规则只在「既不是 markdown 也不是 prompt」时跑。
  assert.equal(matchRule(rule(), surface()).ok, true)
  assert.equal(matchRule(rule(), surface({ isPrompt: true })).reason, 'target')
})

test('编辑历史消息时只有 runOnEdit 的规则跑', () => {
  assert.equal(matchRule(rule(), surface({ isEdit: true })).reason, 'edit')
  assert.equal(matchRule(rule({ runOnEdit: true }), surface({ isEdit: true })).ok, true)
})

test('provider / model / purpose 用 glob 匹配', () => {
  const r = rule({ when: { provider: 'deepseek*', model: '*flash*', purpose: 'chat' } })
  assert.equal(matchRule(r, surface(), { provider: 'deepseek', model: 'v4-flash', purpose: 'chat' }).ok, true)
  assert.equal(matchRule(r, surface(), { provider: 'openai', model: 'v4-flash', purpose: 'chat' }).reason, 'provider')
  assert.equal(matchRule(r, surface(), { provider: 'deepseek', model: 'v4', purpose: 'chat' }).reason, 'model')
  assert.equal(matchRule(r, surface(), { provider: 'deepseek', model: 'v4-flash', purpose: 'title' }).reason, 'purpose')
})

test('工具名与参数：数组表示都要包含', () => {
  const r = rule({ when: { tool: 'read', args: { path: ['D:/dev/src', '.js'] } } })
  const call = args => surface({ placement: PLACEMENT.TOOL_CALL, tool: { name: 'read', args } })
  assert.equal(matchRule(r, call({ path: 'D:/dev/src/a.js' })).ok, true)
  assert.equal(matchRule(r, call({ path: 'D:/dev/src/a.ts' })).reason, 'args')
  assert.equal(matchRule(r, call({})).reason, 'args')
  assert.equal(matchRule(r, surface({ placement: PLACEMENT.TOOL_CALL, tool: { name: 'write', args: { path: 'D:/dev/src/a.js' } } })).reason, 'tool')
})

test('tool 写成数组表示「其中任意一个」', () => {
  const r = rule({ when: { tool: ['read', 'write'] } })
  const call = name => surface({ placement: PLACEMENT.TOOL_CALL, tool: { name, args: {} } })
  assert.equal(matchRule(r, call('read')).ok, true)
  assert.equal(matchRule(r, call('write')).ok, true)
  assert.equal(matchRule(r, call('bash')).reason, 'tool')
  // 数组里也支持 glob。
  assert.equal(matchRule(rule({ when: { tool: ['session_*'] } }), call('session_blocks_remember')).ok, true)
  assert.throws(() => rule({ when: { tool: [] } }), /empty array/)
  assert.throws(() => rule({ when: { tool: [1] } }), /when.tool/)
})

test('matchArgs：非字符串参数按 JSON 找子串', () => {
  assert.equal(matchArgs({ n: '1' }, { n: 123 }), true)
  assert.equal(matchArgs({ n: '4' }, { n: 123 }), false)
  assert.equal(matchArgs({ a: ['1', '2'] }, { a: 12 }), true)
})

test('idle：一段时间没调用过某个工具；从没调用过不算闲置', () => {
  const r = rule({ when: { idle: { since: 'session_blocks_remember', minutes: 10 } } })
  const now = 1000000000
  const ago = minutes => [{ name: 'session_blocks_remember', at: now - minutes * 60000 }]
  assert.equal(matchRule(r, surface(), { now, toolCalls: [] }).reason, 'idle')
  assert.equal(matchRule(r, surface(), { now, toolCalls: ago(11) }).ok, true)
  assert.equal(matchRule(r, surface(), { now, toolCalls: ago(9) }).reason, 'idle')
  // 别的工具被调用不算数。
  assert.equal(matchRule(r, surface(), { now, toolCalls: [{ name: 'other', at: now }] }).reason, 'idle')
})

test('matchIdle 直接调用', () => {
  assert.equal(matchIdle({ since: 'x', minutes: 1 }, { now: 60000, toolCalls: [{ name: 'x', at: 0 }] }), true)
  assert.equal(matchIdle({ since: 'x', minutes: 1 }, { now: 1, toolCalls: [{ name: 'x', at: 0 }] }), false)
})

test('said / produced：文本出现在用户输入或助手输出里', () => {
  const r = rule({ when: { said: '部署', produced: '/上线|发布/' } })
  assert.equal(matchRule(r, surface(), { userText: '帮我部署一下', assistantText: '已经发布了' }).ok, true)
  assert.equal(matchRule(r, surface(), { userText: '帮我看看', assistantText: '已经发布了' }).reason, 'said')
  assert.equal(matchRule(r, surface(), { userText: '帮我部署一下', assistantText: '好的' }).reason, 'produced')
})

test('matchText：/.../ 按正则，其它按子串', () => {
  assert.equal(matchText('abc', 'xxabcxx'), true)
  assert.equal(matchText('/a.c/', 'xabcx'), true)
  assert.equal(matchText('/a.c/', 'axxc'), false)
  assert.equal(matchText('a', ''), false)
  // 空 pattern 是写错了，不是「永远命中」。
  assert.throws(() => matchText('', 'x'), TypeError)
})

test('findRegex：文本里没命中就不跑；正则写坏了直接抛错', () => {
  const r = rule({ action: { kind: 'transform' }, when: { findRegex: '/foo/', replaceString: 'bar' }, budget: { maxCacheLoss: 1 } })
  assert.equal(matchRule(r, surface({ text: 'a foo b' })).ok, true)
  assert.equal(matchRule(r, surface({ text: 'a baz b' })).reason, 'no-match')
  // NONE 模式下写坏的正则，规范化阶段就被拦下了。
  assert.throws(
    () => rule({ id: 'broken', action: { kind: 'transform' }, when: { findRegex: '/(/', replaceString: 'x' }, budget: { maxCacheLoss: 1 } }),
    /not a valid regex/,
  )
  // RAW 模式下正则要等宏替换完才能判，那就到运行时才抛 —— 但一样是抛，不是静默不命中。
  const runtime = rule({
    id: 'runtime', action: { kind: 'transform' },
    when: { findRegex: '/{{q}}/', replaceString: 'x', substituteRegex: 1 },
    budget: { maxCacheLoss: 1 },
  })
  assert.throws(() => matchRule(runtime, surface({ text: 'x' }), {}, { macros: () => '(' }), /not a valid regex/)
})
