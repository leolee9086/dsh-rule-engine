import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CompletionCandidate } from './completion-observation.js'
import type { CompletionNotice, CompletionRequest, CompletionSegment } from './completion-feedback.js'
import type { FeedbackRoute } from './output-feedback.js'

const Notice = z.object({ sessionId: z.string(), eventSeq: z.number().int().nonnegative(),
  route: z.object({ provider: z.string(), model: z.string() }).strict(), label: z.string(), line: z.string(),
  deliveries: z.number().int().nonnegative(), maxDeliveries: z.number().int().positive(),
  status: z.enum(['pending', 'delivery-unknown', 'dispatched', 'superseded']), callId: z.string().optional() }).strict()
export const COMPLETION_NOTICES_DOMAIN = { name: 'context_care_completion_notices', version: 1, layout: 'per-record',
  tables: { notices: { valueSchema: Notice }, processed: { valueSchema: z.number().int().nonnegative() } } }
export interface CompletionTable<T> {
  entries(): Iterable<[string, T]>
  get(key: string): T | undefined
  put(key: string, value: T): Promise<unknown> | unknown
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 保留旧独立调用方的持久交付契约；生产 Session 投影不读取这些旧侧表。 */
export function createCompletionOutbox({ table, processed, render }: {
  table: CompletionTable<CompletionNotice>; processed: CompletionTable<number>; render(candidate: CompletionCandidate): string
}) {
  const values = new Map(table.entries()), reservations = new Map<string, Map<string, CompletionNotice>>()
  async function save(key: string, value: CompletionNotice) { await table.put(key, value); values.set(key, value) }
  async function publish(session: { id: string }, eventSeq: number, route: FeedbackRoute, candidate: CompletionCandidate, maxDeliveries: number) {
    const key = fingerprint({ sessionId: session.id, eventSeq })
    if (values.has(key)) return
    await save(key, { sessionId: String(session.id), eventSeq, route: { provider: route.provider, model: route.model },
      ...candidate, deliveries: 0, maxDeliveries, status: 'pending' })
  }
  function collect(session: { id: string }, request: CompletionRequest): CompletionSegment[] {
    if ((request.purpose ?? 'conversation') !== 'conversation') return []
    return [...values].filter(([, value]) => value.sessionId === String(session.id)
      && (value.status === 'pending' || value.status === 'delivery-unknown') && value.deliveries < value.maxDeliveries
      && value.route.provider === request.provider && value.route.model === request.model)
      .sort((a, b) => b[1].eventSeq - a[1].eventSeq).slice(0, 1).map(([key, value]) => ({
        ruleId: 'completion-observation', version: '1', trigger: 'completion', provider: request.provider, model: request.model,
        purpose: 'conversation', sourceSeqs: [value.eventSeq], completionKey: key, text: render(value) }))
  }
  async function reserve(_session: { id: string }, segments: readonly { ruleId?: string; completionKey?: string }[], callId: string) {
    for (const segment of segments) {
      if (segment.completionKey === undefined) continue
      const old = values.get(segment.completionKey)
      if (!old) throw new Error('context-care: completion reservation has no notice')
      const previous = reservations.get(callId) ?? new Map<string, CompletionNotice>()
      previous.set(segment.completionKey, structuredClone(old)); reservations.set(callId, previous)
      await save(segment.completionKey, { ...old, deliveries: old.deliveries + 1, status: 'delivery-unknown', callId })
    }
  }
  async function rollback(_session: { id: string }, callId: string) {
    for (const [key, previous] of reservations.get(callId) ?? []) {
      const current = values.get(key)
      if (current?.callId === callId && current.status === 'delivery-unknown') await save(key, previous)
    }
    reservations.delete(callId)
  }
  async function dispatched(session: { id: string }, segments: readonly { ruleId?: string; completionKey?: string }[], callId: string, request: CompletionRequest) {
    reservations.delete(callId)
    if ((request.purpose ?? 'conversation') !== 'conversation') return
    const sent = new Set(segments.map(segment => segment.completionKey))
    for (const [key, old] of values) {
      if (old.sessionId !== String(session.id) || (old.status !== 'pending' && old.status !== 'delivery-unknown')) continue
      await save(key, { ...old, callId, status: sent.has(key) ? 'dispatched' : 'superseded' })
    }
  }
  return { publish, collect, reserve, rollback, dispatched, list: () => [...values.values()],
    seen: (session: { id: string }, seq: number) => (processed.get(fingerprint(String(session.id))) ?? -1) >= seq,
    async mark(session: { id: string }, seq: number) { await processed.put(fingerprint(String(session.id)), seq) } }
}
