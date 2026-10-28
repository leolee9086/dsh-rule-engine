import { CLEANABLE_IDS, detectDegradation, type LoopHit } from './loop-patterns.js'
import { isRecord } from './guard.js'

const CLEANERS: Record<string, (text: string, hit: LoopHit) => string> = {
  'line-repeat'(_text, hit) {
    let cut = hit.lines.length
    for (let index = hit.windowStart; index < hit.lines.length; index += 1) {
      if (hit.marks[index] && hit.lines[index].trim() === hit.line) { cut = index; break }
    }
    // 整块清空会失去所有原文；沿用原实现保留最前四分之一。
    if (cut === 0) cut = Math.max(1, Math.floor(hit.lines.length / 4))
    return hit.lines.slice(0, cut).join('\n')
  },
  'filler-lines'(_text, hit) { return hit.lines.filter((_line, index) => !hit.marks[index]).join('\n') },
}
export const CLEAN_PATTERNS = CLEANABLE_IDS.map(id => ({ id, clean: CLEANERS[id] }))
for (const id of CLEANABLE_IDS) if (typeof CLEANERS[id] !== 'function') {
  throw new Error(`loop-clean: 判定表把 "${id}" 标成可清理，但这里没有它的清法`)
}
export interface CleanTail { text: string; removedLines: number; pattern: string | undefined }
/** 只清严重档；首次命中的轻微档仍留给提醒，不在这里继续寻找可删内容。 */
export function cleanTail(text: unknown, only?: readonly string[]): CleanTail {
  const source = String(text), hit = detectDegradation(source, only)
  if (hit === undefined || hit.severity !== 'severe') return { text: source, removedLines: 0, pattern: undefined }
  const pattern = CLEAN_PATTERNS.find(entry => entry.id === hit.pattern)
  if (pattern === undefined) return { text: source, removedLines: 0, pattern: undefined }
  const kept = pattern.clean(source, hit).replace(/\s+$/, '')
  return { text: kept, removedLines: source.split('\n').length - (kept.length === 0 ? 0 : kept.split('\n').length), pattern: hit.pattern }
}
/** 复制改变的文本块，保留原消息身份和未改变的块。 */
export function cleanMessage<M>(message: M, only?: readonly string[]): { message: M; removedLines: number; pattern: string | undefined } {
  if (!isRecord(message) || !Array.isArray(message.content)) return { message, removedLines: 0, pattern: undefined }
  let removedLines = 0, pattern: string | undefined
  const content = message.content.map((block: unknown) => {
    if (!isRecord(block) || typeof block.text !== 'string' || (block.type !== 'reasoning' && block.type !== 'text')) return block
    const cleaned = cleanTail(block.text, only)
    removedLines += cleaned.removedLines
    if (cleaned.pattern !== undefined) pattern = cleaned.pattern
    return cleaned.removedLines === 0 ? block : { ...block, text: cleaned.text }
  })
  return removedLines === 0 ? { message, removedLines: 0, pattern: undefined } : { message: { ...message, content }, removedLines, pattern }
}
/** 只处理最后一条助手消息，早期历史保持逐字原样。 */
export function cleanMessages<M>(messages: M[], only?: readonly string[]): { messages: M[]; removedLines: number; index: number; pattern: string | undefined } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'assistant') continue
    const cleaned = cleanMessage(message, only)
    if (cleaned.removedLines === 0) return { messages, removedLines: 0, index, pattern: undefined }
    const next = [...messages]
    next[index] = cleaned.message
    return { messages: next, removedLines: cleaned.removedLines, index, pattern: cleaned.pattern }
  }
  return { messages, removedLines: 0, index: -1, pattern: undefined }
}
