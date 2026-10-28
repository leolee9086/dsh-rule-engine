import type { V2Block } from './block-rules.js'

export interface DeltaProjectionOptions { sessionId: string; requestId: string; attemptId: string; turnId: string; maxChars?: number; maxBlocks?: number }
export interface DeltaChunk { type: string; index?: number; text?: unknown }
export interface DeltaOccurrence { sourceId: string; ruleId: string; ruleRevision: number; blockId: string }
export interface DeltaBlock extends V2Block { sessionId: string; requestId: string; attemptId: string; blockKey: number; messageId: string; turnId: string; text: string; raw: { type: string; text: string } }

/** 有界的请求内证据。流身份不冒充已经提交的 seq/path；策略边界变化就丢弃旧文本。 */
export function createDeltaProjection({ sessionId, requestId, attemptId, turnId, maxChars = 32768, maxBlocks = 128 }: DeltaProjectionOptions) {
  const blocks = new Map<number, { text: string; type: string }>(), fired = new Set<string>()
  let policy: unknown, ended = false
  const identity = (index: number) => JSON.stringify([sessionId, requestId, attemptId, index])
  const occurrence = (event: DeltaOccurrence) => JSON.stringify([event.sourceId, event.ruleId, event.ruleRevision, event.blockId])
  return {
    feed(chunk: DeltaChunk, currentPolicy?: unknown): DeltaBlock[] {
      if (ended) throw new Error('delta-projection-ended')
      if (policy !== currentPolicy) { blocks.clear(); policy = currentPolicy }
      if (chunk.type === 'finish') { blocks.clear(); ended = true; return [] }
      if (chunk.type === 'block-end') { if (chunk.index !== undefined) blocks.delete(chunk.index); return [] }
      if (!['text-delta', 'reasoning-delta'].includes(chunk.type)) return []
      if (chunk.index === undefined || !Number.isSafeInteger(chunk.index) || chunk.index < 0 || typeof chunk.text !== 'string') throw new Error('delta-chunk-invalid')
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning', previous = blocks.get(chunk.index)
      if (previous && previous.type !== type) throw new Error('delta-block-type-changed')
      if (!previous && blocks.size >= maxBlocks) throw new Error('delta-block-budget-exceeded')
      const index = chunk.index, text = (previous?.text ?? '') + chunk.text
      // 不裁掉前缀，避免改变正则锚点和原始捕获坐标。
      if (text.length > maxChars) throw new Error('delta-text-budget-exceeded')
      blocks.set(index, { text, type })
      return ['original', 'model'].map(view => ({ id: JSON.stringify([identity(index), view]), sessionId, requestId, attemptId, blockKey: index,
        messageId: JSON.stringify([requestId, attemptId]), turnId, role: 'assistant', view, type, text, raw: { type, text } }))
    },
    finalize(index?: number): DeltaBlock[] {
      if (ended) return []
      return [...blocks].filter(([key]) => index === undefined || key === index).flatMap(([key, value]) => ['original', 'model'].map(view => ({
        id: JSON.stringify([identity(key), view]), sessionId, requestId, attemptId, blockKey: key, messageId: JSON.stringify([requestId, attemptId]), turnId,
        role: 'assistant', view, ...value, raw: { type: value.type, text: value.text }, detectorPhase: 'finalize',
      })))
    },
    unseen<E extends DeltaOccurrence>(events: readonly E[]): E[] {
      // 每个规则每个流块只接纳一次，捕获随 token 增长不再重复排入动作。
      return events.filter(event => !fired.has(occurrence(event)))
    },
    acknowledge(events: readonly DeltaOccurrence[]): void { for (const event of events) fired.add(occurrence(event)) },
    close(): void { blocks.clear(); fired.clear(); ended = true },
  }
}
