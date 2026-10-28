import { createHash } from 'node:crypto'
import { parseCompletion, type CompletionCandidate } from './completion-observation.js'
import type { FeedbackRoute, OutputFeedbackSession, OutputFeedbackCachePort } from './output-feedback.js'
import type { PlanningCacheKey } from './planning-cache.js'

export interface CompletionRequest extends FeedbackRoute { purpose?: string }
export interface CompletionNotice extends CompletionCandidate {
  sessionId: string; eventSeq: number; route: FeedbackRoute; deliveries: number; maxDeliveries: number
  status: 'pending' | 'delivery-unknown' | 'dispatched' | 'superseded'; callId?: string
}
export interface CompletionSegment extends FeedbackRoute {
  ruleId: 'completion-observation'; version: '1'; trigger: 'completion'; purpose: 'conversation'
  sourceSeqs: number[]; completionKey: string; text: string
}
export type CompletionFact =
  | { type: 'request/header'; seq: number; route?: FeedbackRoute; prompt?: { callId: string; segments: readonly { ruleId?: unknown; completionKey?: unknown }[] } }
  | { type: 'step/start'; seq: number }
  | { type: 'assistant/message' | 'assistant/attempt'; seq: number; time: number; completed: boolean; received: boolean; text: Iterable<string> }
export interface CompletionFactRead extends Disposable, Iterable<CompletionFact> { readonly length: number }
export interface CompletionFeedbackOptions<S extends OutputFeedbackSession> {
  cache: OutputFeedbackCachePort
  sessions: { get(id: string): S | undefined; list(): readonly S[]; flush(session: S): Promise<unknown> | void }
  facts(session: S, fromSeq: number): CompletionFactRead
  cooldownMs: number; maxObservedChars: number; maxDeliveries: number
  active(session: S): boolean
  since(session: S): number
  parse?(text: string): CompletionCandidate | undefined
  render(notice: CompletionCandidate): string
}
interface Receipt { callId: string; keys: Set<string> }
interface Projection {
  through: number; since: number; route?: FeedbackRoute; lastCompletedAt?: number
  notices: Map<string, CompletionNotice>; receipts: Map<string, Receipt>; prompt?: Receipt
}
const keyOf = (sessionId: string, eventSeq: number) => createHash('sha256').update(JSON.stringify({ sessionId, eventSeq })).digest('hex')
const sameRoute = (left: FeedbackRoute, right: FeedbackRoute) => left.provider === right.provider && left.model === right.model

/** 原生事实投影驱动完成提醒；冷却、候选、预约和未知回执额度都在同一库实现。 */
export function createCompletionFeedback<S extends OutputFeedbackSession>(options: CompletionFeedbackOptions<S>) {
  const stateKey: PlanningCacheKey<S, Projection> = options.cache.define('completion-projection',
    'Native Session identity and completion-control since-seq; only committed relevant events advance the projection.',
    (_session, [since]) => {
      if (typeof since !== 'number') throw new Error('context-care: completion projection requires since-seq')
      return { through: 0, since, notices: new Map(), receipts: new Map() }
    })
  const reservations = new Map<string, { sessionId: string; keys: Set<string> }>()
  const stateOf = (session: S) => options.cache.use(session, stateKey, [options.since(session)])
  function apply(state: Projection, session: S, event: CompletionFact) {
    if (event.type === 'request/header') state.route = event.route
    // 分支只继承可读文本，不继承父会话的本地候选或冷却。
    if (event.seq < session.inheritedEventCount) return
    if (event.type === 'step/start') state.prompt = undefined
    if (event.type === 'request/header' && event.prompt) {
      const keys = new Set(event.prompt.segments.flatMap(segment =>
        segment.ruleId === 'completion-observation' && typeof segment.completionKey === 'string' ? [segment.completionKey] : []))
      const receipt = { callId: event.prompt.callId, keys }
      state.receipts.set(receipt.callId, receipt); state.prompt = receipt
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const prompt = state.prompt
    state.prompt = undefined
    if (prompt?.keys.size && (event.completed || event.received) && state.route) {
      for (const [key, notice] of state.notices) {
        if (notice.eventSeq >= event.seq || !sameRoute(notice.route, state.route)
          || notice.status === 'dispatched' || notice.status === 'superseded') continue
        notice.status = prompt.keys.has(key) ? 'dispatched' : 'superseded'
        if (prompt.keys.has(key)) notice.callId = prompt.callId
      }
    }
    if (!event.completed || event.type !== 'assistant/message' || !state.route || event.seq <= state.since) return
    let length = 0
    const parts: string[] = []
    // 在拼接前检查完整文本预算；超大原生块不先复制成另一个巨型字符串。
    for (const text of event.text) {
      length += text.length + (parts.length ? 2 : 0)
      if (length > options.maxObservedChars) return
      parts.push(text)
    }
    const candidate = (options.parse ?? parseCompletion)(parts.join('\n\n'))
    if (!candidate || (state.lastCompletedAt !== undefined && event.time < state.lastCompletedAt + options.cooldownMs)) return
    state.lastCompletedAt = event.time
    state.notices.set(keyOf(String(session.id), event.seq), { sessionId: String(session.id), eventSeq: event.seq,
      route: { provider: state.route.provider, model: state.route.model }, ...candidate, deliveries: 0, maxDeliveries: options.maxDeliveries, status: 'pending' })
  }
  function read(session: S): Projection {
    const state = stateOf(session)
    try {
      using log = options.facts(session, state.through)
      for (const event of log) { apply(state, session, event); state.through = event.seq + 1 }
      state.through = log.length
      return state
    } catch (error) { options.cache.invalidate(session, stateKey); throw error }
  }
  function notices(session: S): Map<string, CompletionNotice> {
    const state = read(session), result = new Map<string, CompletionNotice>()
    for (const [key, cached] of state.notices) {
      const matching = [...state.receipts.values()].filter(receipt => receipt.keys.has(key))
      const last = matching[matching.length - 1]
      result.set(key, { ...cached, route: { ...cached.route }, deliveries: matching.length,
        ...(last && cached.status === 'pending' ? { status: 'delivery-unknown', callId: last.callId } : {}) })
    }
    return result
  }
  function selected(sessionId?: string): readonly S[] {
    if (sessionId === undefined) return options.sessions.list()
    const session = options.sessions.get(sessionId)
    return session ? [session] : []
  }
  return {
    async flush(sessionId?: string) { await Promise.all(selected(sessionId).map(session => options.sessions.flush(session))) },
    async reconcile(session: S) { if (options.active(session)) read(session) },
    collect(session: S, request: CompletionRequest): CompletionSegment[] {
      if (!options.active(session) || (request.purpose ?? 'conversation') !== 'conversation') return []
      const held = new Set([...reservations.values()].filter(value => value.sessionId === String(session.id)).flatMap(value => [...value.keys]))
      return [...notices(session)].filter(([key, notice]) => !held.has(key)
        && (notice.status === 'pending' || notice.status === 'delivery-unknown')
        && notice.deliveries < notice.maxDeliveries && sameRoute(notice.route, request))
        .sort((left, right) => right[1].eventSeq - left[1].eventSeq).slice(0, 1).map(([key, notice]) => ({
          ruleId: 'completion-observation', version: '1', trigger: 'completion', provider: request.provider, model: request.model,
          purpose: 'conversation', sourceSeqs: [notice.eventSeq], completionKey: key, text: options.render(notice) }))
    },
    async reserve(session: S, segments: readonly { ruleId?: string; completionKey?: string }[], callId: string) {
      reservations.set(callId, { sessionId: String(session.id),
        keys: new Set(segments.flatMap(segment => segment.completionKey === undefined ? [] : [segment.completionKey])) })
    },
    async rollback(_session: S, callId: string) { reservations.delete(callId) },
    async dispatched(session: S, _segments: readonly { ruleId?: string; completionKey?: string }[], callId: string, _request: CompletionRequest) {
      reservations.delete(callId); read(session)
    },
    list(sessionId?: string): CompletionNotice[] { return selected(sessionId).filter(options.active).flatMap(session => [...notices(session).values()]) },
    clear() { options.cache.clear(stateKey); reservations.clear() },
    close() { options.cache.clear(stateKey); reservations.clear() },
  }
}
