import { createHash } from 'node:crypto'
import { z } from 'zod'
import { markdownStatements } from './text-projection.js'

const ENGLISH = /\b(?:done|complete|completed|finished|successfully finished|task complete|all set)\b/i
const CHINESE = /(?:已完成|完成了|任务完成|处理完毕|全部完成|搞定)/u
const NEGATED_ENGLISH = /\b(?:not|never|isn't|is not|unfinished)\b[\s\S]{0,24}\b(?:done|complete|completed|finished)\b/i
const NEGATED_CHINESE = /(?:未完成|没完成|没有完成|尚未完成|还没完成|未搞定)/u
export const CompletionConfig = z.object({ cooldownMs: z.number().int().nonnegative().default(300000),
  maxObservedChars: z.number().int().positive().default(65536), notifications: z.boolean().default(true),
  maxDeliveries: z.number().int().positive().default(2) }).strict().prefault({})
export interface CompletionCandidate { label: string; line: string }

/** 只观察可见的肯定完成措辞，不把措辞当作任务已交付的证据。 */
export function parseCompletion(text: string): CompletionCandidate | undefined {
  for (const statement of markdownStatements(String(text))) {
    const line = statement.text.trim()
    if (!line.length || NEGATED_ENGLISH.test(line) || NEGATED_CHINESE.test(line)) continue
    const match = line.match(ENGLISH) ?? line.match(CHINESE)
    if (match !== null) return { label: match[0], line }
  }
  return undefined
}
const CompletionPending = z.object({ occurrenceId: z.string().min(1), label: z.string().min(1), line: z.string().min(1) }).strict()
export const CompletionObservationState = z.object({ version: z.literal(1), pending: CompletionPending.optional(),
  cooldownUntil: z.number().int().nonnegative(), completedOccurrenceId: z.string().optional() }).strict()
export type CompletionObservation = z.output<typeof CompletionObservationState>
export const COMPLETION_STATE_DOMAIN = { name: 'context_care_completion', version: 1, layout: 'per-record',
  tables: { observations: { valueSchema: CompletionObservationState } } }

/** 保留旧存储身份；过去无法形成文件名的超长身份才使用固定长度哈希。 */
export function completionStateKey(sessionId: unknown, sourceId: unknown): string {
  if (typeof sessionId !== 'string' || !sessionId.length) throw new Error('completion state requires sessionId')
  if (typeof sourceId !== 'string' || !sourceId.length) throw new Error('completion state requires sourceId')
  const encode = (value: string) => [...value].map(character => character.codePointAt(0)?.toString(16).padStart(6, '0')).join('')
  const legacy = `${encode(sessionId)}_${encode(sourceId)}`
  return legacy.length <= 250 ? legacy : `sha256_${createHash('sha256').update(JSON.stringify([sessionId, sourceId])).digest('hex')}`
}
interface Identity { sessionId: string; sourceId: string; occurrenceId?: string }
export interface CompletionObserverOptions {
  load(key: string): CompletionObservation | undefined | null | Promise<CompletionObservation | undefined | null>
  save(key: string, value: CompletionObservation): unknown | Promise<unknown>
  now?: () => number
  cooldownMs?: number
}
/** 旧独立调用方仍能恢复原状态；库拥有转换，Host 拥有打开与确认存储。 */
export function createCompletionObserver({ load, save, now = () => Date.now(), cooldownMs = 300000 }: CompletionObserverOptions) {
  if (typeof load !== 'function' || typeof save !== 'function') throw new Error('completion observer requires a durable load/save store')
  async function current(key: string): Promise<CompletionObservation> {
    const value = await load(key)
    return value === undefined || value === null ? { version: 1, pending: undefined, cooldownUntil: 0 } : value
  }
  async function observe(input: Identity & { text: string }, eligible = () => true) {
    const key = completionStateKey(input?.sessionId, input?.sourceId), candidate = parseCompletion(input.text)
    if (candidate === undefined) return { status: 'ignored', key }
    const previous = await current(key)
    if (!eligible()) return { status: 'disabled', key, state: previous }
    if (previous.cooldownUntil > now()) return { status: 'cooldown', key, state: previous }
    if (previous.pending?.line === candidate.line && (input.occurrenceId === undefined || previous.pending.occurrenceId === input.occurrenceId)) {
      return { status: 'pending', key, state: previous }
    }
    const next: CompletionObservation = { version: 1,
      pending: { occurrenceId: input.occurrenceId ?? `${now()}`, label: candidate.label, line: candidate.line }, cooldownUntil: 0 }
    await save(key, next)
    return { status: 'pending', key, state: next }
  }
  async function settle(input: Identity & { outcome?: string }, eligible = () => true) {
    const key = completionStateKey(input?.sessionId, input?.sourceId), previous = await current(key)
    if (!eligible()) return { status: 'disabled', key, state: previous }
    if (previous.pending === undefined || (input.occurrenceId !== undefined && previous.pending.occurrenceId !== input.occurrenceId)) {
      return { status: 'recovery', key, state: previous }
    }
    const completed = input.outcome === undefined || input.outcome === 'completed'
    const next: CompletionObservation = { version: 1, pending: undefined, cooldownUntil: completed ? now() + cooldownMs : 0,
      ...(completed ? { completedOccurrenceId: previous.pending.occurrenceId }
        : previous.completedOccurrenceId === undefined ? {} : { completedOccurrenceId: previous.completedOccurrenceId }) }
    await save(key, next)
    return { status: input.outcome === 'recovered' ? 'recovered' : completed ? 'completed' : 'failed', key, state: next }
  }
  return { observe, settle, recover: (input: Identity) => settle({ ...input, outcome: 'recovered' }) }
}
