import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, selectWithinBudget } from '../lib/index.js'
import { PLACEMENT } from '../lib/placement.js'

/** 一次请求被切成若干片段：system、历史、思考、用户输入。 */
function requestSegments() {
  return [
    'system: 你是织。' + 'S'.repeat(500),
    'history: ' + 'H'.repeat(500),
    'reasoning: ' + 'Thinking... '.repeat(20) + 'R'.repeat(300),
    'user: 帮我看看 D:/secret/key.txt 这个文件',
  ]
}

test('端到端：预算够时，思考清洗和隐私清洗一起做', () => {
  const segments = requestSegments()
  const plan = selectWithinBudget({
    previous: segments.join(''),
    segments,
    replacements: [
      { index: 2, text: 'reasoning: ' + 'R'.repeat(300) },
      { index: 3, text: 'user: 帮我看看 [已隐藏] 这个文件', required: true },
    ],
    maxCacheLoss: 0.5,
  })
  assert.deepEqual(plan.accepted, [2, 3])
  assert.deepEqual(plan.rejected, [])
  assert.equal(plan.text.includes('Thinking...'), false)
  assert.equal(plan.text.includes('D:/secret/key.txt'), false)
  assert.equal(plan.exceedsBudget, false)
})

test('端到端：预算不够时保留靠后的改动，砍掉靠前的', () => {
  const segments = requestSegments()
  const plan = selectWithinBudget({
    previous: segments.join(''),
    segments,
    replacements: [
      { index: 0, text: 'system: 你是织。' + 'X'.repeat(500) },
      { index: 3, text: 'user: 帮我看看 [已隐藏] 这个文件', required: true },
    ],
    maxCacheLoss: 0.2,
  })
  // 改 system 会把整条前缀废掉，超预算；改最后一段几乎不花钱。
  assert.deepEqual(plan.accepted, [3])
  assert.deepEqual(plan.rejected, [0])
  assert.equal(plan.text.startsWith('system: 你是织。' + 'S'.repeat(500)), true)
})

test('端到端：必须做的改动本身超预算，调用方据此拒绝发送', () => {
  const segments = ['a'.repeat(10), 'b'.repeat(10)]
  const plan = selectWithinBudget({
    previous: segments.join(''),
    segments,
    replacements: [{ index: 0, text: 'c'.repeat(10), required: true }],
    maxCacheLoss: 0.1,
  })
  assert.equal(plan.exceedsBudget, true)
  assert.deepEqual(plan.forced, [0])
})

test('端到端：引擎把动作交给两个消费者，并留下记录', () => {
  const records = []
  const delivered = []
  const engine = createEngine({
    rules: [
      {
        id: 'scrub-empty-reasoning', order: 10, placement: ['reasoning'],
        when: { findRegex: '/(Thinking\\.\\.\\. )+/g', replaceString: '' },
        action: { kind: 'transform', by: 'fetch-router' },
        budget: { maxCacheLoss: 0.5 },
      },
      {
        id: 'remind-remember', order: 20, placement: ['reasoning'],
        when: { idle: { since: 'session_blocks_remember', minutes: 10 } },
        action: { kind: 'notify', by: 'context-care' },
        cooldownMinutes: 30,
      },
    ],
    onRecord: record => records.push(record),
  })
  engine.registerConsumer({ name: 'fetch-router', kinds: ['transform'], handle: payload => delivered.push(['transform', payload.text]) })
  engine.registerConsumer({ name: 'context-care', kinds: ['notify'], handle: payload => delivered.push(['notify', payload.ruleId]) })

  const now = 1000000000
  const result = engine.run({
    surface: { placement: PLACEMENT.REASONING, text: 'Thinking... Thinking... 想到了' },
    ctx: { now, toolCalls: [{ name: 'session_blocks_remember', at: now - 20 * 60000 }] },
  })

  assert.equal(result.text, '想到了')
  assert.deepEqual(result.delivered.sort(), ['context-care', 'fetch-router'])
  assert.deepEqual(records.map(record => record.ruleId), ['scrub-empty-reasoning', 'remind-remember'])
  assert.deepEqual(records.map(record => record.outcome), ['applied', 'applied'])

  // 冷却：刚提醒过，下一轮不再提醒。
  const second = engine.run({
    surface: { placement: PLACEMENT.REASONING, text: '想到了' },
    ctx: { now: now + 60000, toolCalls: [{ name: 'session_blocks_remember', at: now - 21 * 60000 }] },
  })
  assert.deepEqual(second.records.map(record => record.outcome), ['cooldown'])
  assert.equal(second.text, '想到了')
})
