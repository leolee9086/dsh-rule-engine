import { randomUUID } from 'node:crypto'
import { createEngine, type Engine, type EngineRecord } from './engine.js'
import type { ToolCallRecord } from './match.js'
import { isRecord } from './guard.js'

export interface NoticeRuleInput {
  key: string; sessionId?: string; text: string; assistantText: string; toolCalls: readonly ToolCallRecord[]
  facts?: Record<string, unknown>; evidence: Record<string, unknown>
}
export interface NoticeRuleTrace extends Record<string, unknown> { trigger: 'notice-rule'; ruleId: string }
export interface NoticeRuleRecord extends EngineRecord { evaluationId: string; rule: unknown; [key: string]: unknown }
export interface NoticeRuleRuntimeOptions {
  rulesFor(sessionId: string | undefined, evidence: Record<string, unknown>): unknown
  engine?: Engine
  onHit?(record: NoticeRuleRecord, where: { sessionId: string | undefined }): void
  warn?(message: string): void
  consumer?: string; source?: string
}
/** 原生通知只是同一引擎文本事务的呈现端口，不建立按会话分叉的引擎。 */
export function createNoticeRuleRuntime({ rulesFor, engine = createEngine(), onHit = () => {}, warn = message => console.warn(message),
  consumer = 'context-care', source = 'memoryNoticeRules' }: NoticeRuleRuntimeOptions) {
  return { collect(input: NoticeRuleInput): { text: string; ruleId: string; trace: NoticeRuleTrace }[] {
    if (!input.text.length) return []
    const rules = rulesFor(input.sessionId, input.evidence) ?? [], hits: NoticeRuleRecord[] = []
    const transaction = engine.prepare({ key: `${source}:${input.key}`, rules,
      surface: { placement: 'user', text: input.text },
      ctx: { userText: input.text, assistantText: input.assistantText, toolCalls: input.toolCalls, now: Date.now(), ...(input.facts ?? {}) },
      consumers: [{ name: consumer, kinds: ['notify'], handle() {} }],
      onRecord(record) {
        const rule = Array.isArray(rules) ? rules.find((value: unknown) => isRecord(value) && value.id === record.ruleId) : undefined
        const captured = { ...record, evaluationId: randomUUID(), ...input.evidence, rule }
        onHit(captured, { sessionId: input.sessionId }); hits.push(captured)
        if (record.outcome !== 'applied') warn(`context-care: 提示规则 ${record.ruleId} 未生效(${record.outcome})${record.detail === undefined ? '' : ': ' + record.detail}`)
      } })
    // 正文先校验，失败不能消费去重/冷却。
    const notices = transaction.payloads.map(payload => {
      const text = payload.action?.say
      if (typeof text !== 'string' || !text.length) throw new Error(`context-care: 提示规则 "${payload.ruleId}" 没有 action.say,不知道该提醒什么`)
      return { text, ruleId: payload.ruleId }
    })
    transaction.commit()
    return notices.map(notice => {
      const evaluation = hits.find(hit => hit.ruleId === notice.ruleId && hit.outcome === 'applied')
      return { ...notice, trace: { trigger: 'notice-rule', ruleId: notice.ruleId, evaluationId: evaluation?.evaluationId,
        userText: input.text, sourceSeqs: evaluation?.sourceSeqs ?? [], facts: input.facts, evaluation, rule: evaluation?.rule } }
    })
  } }
}
