import { createEngine, type Engine, type EngineRecord } from './engine.js'
import { cleanMessages } from './loop-clean.js'
import { isRecord } from './guard.js'

export const REWRITER_NAME = 'context-care'
export interface RewriteBlockEvidence { hash: string; charsBefore: number; charsAfter: number; removed?: string; added?: string }
export interface RequestRewriteOptions {
  engine?: Engine
  rules(sessionId?: string): unknown
  onRecord(record: EngineRecord | LoopRewriteRecord, where: { sessionId: string | undefined }): void
  journal?: { record(record: RewriteBlockEvidence & { sessionId: string; pattern: string; removedLines?: number }): Promise<unknown> | unknown }
  blocksChanged?(before: string, after: string): readonly RewriteBlockEvidence[]
  cleanPatterns?(sessionId?: string): readonly string[] | undefined
  revision?(sessionId?: string): unknown
}
export interface LoopRewriteRecord { layer: 'loop'; ruleId: string; outcome: 'applied'; loss: number; detail: string }
function cleanLoopInBody(body: string, only?: readonly string[]) {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return undefined }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return undefined
  const cleaned = cleanMessages(parsed.messages, only)
  if (!cleaned.removedLines) return undefined
  return { body: JSON.stringify({ ...parsed, messages: cleaned.messages }), removedLines: cleaned.removedLines, pattern: cleaned.pattern }
}

/** 请求改写是有 ACK 边界的引擎事务：未确认或控制已变时，不消耗冷却、去重或前缀基线。 */
export function createRequestRewriter({ rules, onRecord, journal, blocksChanged, cleanPatterns, revision = () => 0, engine = createEngine() }: RequestRewriteOptions) {
  const lastSent = new Map<string, string>()
  return async function rewrite({ body, url, scope }: { body: string; url: string; scope?: { sessionId?: unknown } }): Promise<string | undefined> {
    const sessionId = typeof scope?.sessionId === 'string' ? scope.sessionId : undefined
    const capturedRevision = revision(sessionId), parsed = new URL(url)
    const key = JSON.stringify([sessionId, parsed.host + parsed.pathname]), previous = lastSent.get(key) ?? null
    const input = rules(sessionId)
    if (!Array.isArray(input)) throw new TypeError('context-care: rule source must return an array')
    const transaction = engine.prepare({ key: JSON.stringify(['request-rewrite', sessionId]), rules: input,
      surface: { placement: 'request', text: body }, ctx: { now: Date.now(), previous },
      consumers: [{ name: REWRITER_NAME, kinds: ['transform'], handle() {} }], current: () => revision(sessionId) === capturedRevision })
    const evaluated = transaction.result
    const records = evaluated.records
    let text = evaluated.text
    const loop = cleanLoopInBody(text, cleanPatterns?.(sessionId))
    let loopRecord: LoopRewriteRecord | undefined
    if (loop !== undefined) {
      text = loop.body
      loopRecord = { layer: 'loop', ruleId: `loop-clean:${loop.pattern}`, outcome: 'applied', loss: 0, detail: `最后一条助手消息去掉 ${loop.removedLines} 行` }
    }
    if (journal !== undefined && sessionId !== undefined && text !== body) {
      if (!blocksChanged) throw new Error('context-care: rewrite evidence port unavailable')
      const applied = records.find(record => record.outcome === 'applied')
      for (const block of blocksChanged(body, text)) await journal.record({ sessionId, ...block,
        pattern: loop === undefined ? (applied?.ruleId ?? 'transform') : `loop-clean:${loop.pattern}`, removedLines: loop?.removedLines })
    }
    // ACK 等待期间的控制变更必须显式拒绝；提案日志不能冒充实际交付。
    if (revision(sessionId) !== capturedRevision) throw Object.assign(new Error('context-care: rule controls changed while acknowledging request rewrite'), { code: 'CONTROL_CHANGED' })
    transaction.commit()
    lastSent.set(key, text)
    if (loopRecord) onRecord(loopRecord, { sessionId })
    for (const record of records) onRecord(record, { sessionId })
    return text === body ? undefined : text
  }
}
