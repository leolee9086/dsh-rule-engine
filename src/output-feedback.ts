import { createHash } from 'node:crypto'
import type { PlanningCacheKey, PlanningCachePort } from './planning-cache.js'

export interface FeedbackRoute { provider: string; model: string }
export interface OutputFeedbackBounds { windowOutputs: number; cooldownCompletedOutputs: number; rearmHealthyOutputs: number; maxDeliveries: number }
export interface OutputFeedbackRule<D> extends FeedbackRoute {
  ruleId: string; version: string; trigger: string; text: string; detector?: D; carryFromOtherRoute?: boolean
}
export interface OutputFeedbackMetrics { status: string; H?: number; K?: number; N?: number; evidence?: readonly { text: string }[] }
type Sample<M> = M & { seq: number }
type Measured<M> = Sample<M> & { H: number; K: number; N: number; evidence: readonly { text: string }[] }
interface Pending<M> { segmentId: string; sourceSeqs: number[]; sample: Measured<M>; trigger: string; deliveries: number; maxDeliveries: number }
interface Delivery { segmentId: string; callId: string; status: string; attempts?: number; exhausted?: boolean }
export interface OutputFeedbackEpisode<M> {
  version: 1; sessionId: string; ruleId: string; ruleVersion: string; specHash: string; route: FeedbackRoute
  lastSeq: number; completed: number; cooldownUntil: number; healthy: number; window: Sample<M>[]
  pending?: Pending<M>; lastDelivery?: Delivery
}
interface Receipt { callId: string; keys: Set<string> }
interface Projection<M> { through: number; route?: FeedbackRoute; prompt?: Receipt; receipts: Set<string>; episodes: Map<string, OutputFeedbackEpisode<M>> }
export interface OutputFeedbackSegment<M> extends FeedbackRoute {
  ruleId: string; version: string; trigger: 'output-pattern'; purpose: 'conversation'; text: string; segmentId: string
  sourceRoute: FeedbackRoute; sourceSeqs: number[]; metrics: Sample<M>; feedbackKey: string
}
export interface OutputFeedbackSession { readonly id: string; readonly seq: number; readonly inheritedEventCount: number }
export type OutputFeedbackFact =
  | { type: 'request/header'; seq: number; route?: FeedbackRoute; prompt?: { callId: string; segments: readonly { feedbackKey?: unknown; sourceSeqs?: unknown }[] } }
  | { type: 'step/start'; seq: number }
  | { type: 'assistant/message' | 'assistant/attempt'; seq: number; completed: boolean; received: boolean; text: string }
export interface OutputFeedbackFactRead extends Disposable, Iterable<OutputFeedbackFact> { readonly length: number }
export interface OutputFeedbackCachePort extends PlanningCachePort { invalidate(owner: object, key: object): void }
export interface OutputFeedbackOptions<S extends OutputFeedbackSession, D, M> {
  sessions: { get(sessionId: string): S | undefined; list(): readonly S[]; flush(session: S): Promise<unknown> | void }
  cache: OutputFeedbackCachePort
  facts(session: S, fromSeq: number): OutputFeedbackFactRead
  detect(text: string, config: D): M
  trigger(sample: Sample<M>, window: readonly Sample<M>[], config: D): string | undefined
  rulesFor(sessionId: string): readonly OutputFeedbackRule<D>[]
  eligible(sessionId: string, ruleId: string, seqs: number[]): boolean
  revision(sessionId: string): number
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const keyFor = (sessionId: string, rule: unknown) => fingerprint({ sessionId, rule })
const sameRoute = (left: FeedbackRoute, right: FeedbackRoute) => left.provider === right.provider && left.model === right.model
function requireMeasured<M extends OutputFeedbackMetrics>(sample: Sample<M>): asserts sample is Measured<M> {
  if (sample.status !== 'measured' || typeof sample.H !== 'number' || typeof sample.K !== 'number'
    || typeof sample.N !== 'number' || !Array.isArray(sample.evidence)) throw new Error('context-care: output trigger requires measured native evidence')
}

/** 通用输出反馈策略。原生读取和共享缓存由 Host 持有，不在库内另建日志或侧表。 */
export function createOutputFeedback<S extends OutputFeedbackSession, D extends OutputFeedbackBounds, M extends OutputFeedbackMetrics>(options: OutputFeedbackOptions<S, D, M>) {
  const stateKey: PlanningCacheKey<S, Projection<M>> = options.cache.define('output-feedback',
    'Native Session identity; rule signature, settings revision and committed event cursor.', () => ({ through: 0, receipts: new Set(), episodes: new Map() }))
  const reservations = new Map<string, { sessionId: string; keys: Set<string> }>()
  function apply(state: Projection<M>, session: S, event: OutputFeedbackFact, rules: readonly OutputFeedbackRule<D>[]) {
    if (event.type === 'request/header') state.route = event.route
    if (event.seq < session.inheritedEventCount) return
    if (event.type === 'step/start') state.prompt = undefined
    if (event.type === 'request/header' && event.prompt) {
      const prompt = event.prompt, keys = new Set<string>(), duplicate = state.receipts.has(prompt.callId)
      for (const segment of prompt.segments) {
        if (typeof segment.feedbackKey !== 'string' || !Array.isArray(segment.sourceSeqs) || keys.has(segment.feedbackKey)) continue
        const episode = state.episodes.get(segment.feedbackKey), pending = episode?.pending
        // 原生来源位置绑定真实片段，包括历史的随机 segmentId。
        if (!episode || !pending || JSON.stringify(segment.sourceSeqs) !== JSON.stringify(pending.sourceSeqs)) continue
        keys.add(segment.feedbackKey)
        if (duplicate) continue
        pending.deliveries++
        episode.lastDelivery = { segmentId: pending.segmentId, callId: prompt.callId, status: 'delivery-unknown', attempts: pending.deliveries }
      }
      state.prompt = { callId: prompt.callId, keys }
      if (keys.size) state.receipts.add(prompt.callId)
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const prompt = state.prompt
    state.prompt = undefined
    const route = state.route
    if (!route) return
    if (event.completed || event.received) {
      for (const [key, episode] of state.episodes) {
        const pending = episode.pending
        if (!pending || episode.lastSeq >= event.seq) continue
        if (prompt?.keys.has(key)) {
          episode.lastDelivery = { ...episode.lastDelivery, segmentId: pending.segmentId, callId: prompt.callId, status: 'dispatched' }
          delete episode.pending
        } else if (!sameRoute(episode.route, route)) {
          episode.lastDelivery = { segmentId: pending.segmentId, callId: prompt?.callId ?? `session:${session.id}:request:${event.seq}`, status: 'superseded' }
          delete episode.pending
        }
      }
    }
    if (!event.completed || event.type !== 'assistant/message') return
    for (const rule of rules) {
      const detector = rule.detector
      if (rule.trigger !== 'output-pattern' || !detector || !sameRoute(rule, route)
        || !options.eligible(String(session.id), rule.ruleId, [event.seq])) continue
      const key = keyFor(String(session.id), rule)
      let episode = state.episodes.get(key)
      if (!episode) {
        episode = { version: 1, sessionId: String(session.id), ruleId: rule.ruleId, ruleVersion: rule.version,
          specHash: fingerprint(detector), route: { provider: route.provider, model: route.model },
          lastSeq: event.seq, completed: 0, cooldownUntil: 0, healthy: 0, window: [] }
        state.episodes.set(key, episode)
      }
      const sample: Sample<M> = { ...options.detect(event.text, detector), seq: event.seq }
      episode.lastSeq = event.seq; episode.completed++
      episode.window = [...episode.window, sample].slice(-detector.windowOutputs)
      const trigger = options.trigger(sample, episode.window, detector)
      if (episode.pending && episode.pending.deliveries >= episode.pending.maxDeliveries) {
        if (episode.lastDelivery) episode.lastDelivery.exhausted = true
        delete episode.pending
      }
      episode.healthy = sample.status === 'measured' && sample.K === 0 ? episode.healthy + 1 : 0
      if (episode.healthy >= detector.rearmHealthyOutputs) episode.cooldownUntil = 0
      if (trigger !== undefined && !episode.pending && episode.completed > episode.cooldownUntil) {
        requireMeasured(sample)
        const sourceSeqs = trigger === 'window' ? episode.window.map(value => value.seq) : [event.seq]
        episode.pending = { segmentId: fingerprint({ key, sourceSeqs }), sourceSeqs, sample, trigger, deliveries: 0, maxDeliveries: detector.maxDeliveries }
        episode.cooldownUntil = episode.completed + detector.cooldownCompletedOutputs
      }
    }
  }
  function read(session: S, rules = options.rulesFor(String(session.id))) {
    const signature = fingerprint({ rules, revision: options.revision(String(session.id)) })
    const state = options.cache.use(session, stateKey, [signature])
    if (!rules.some(rule => rule.trigger === 'output-pattern')) { state.through = session.seq; return state }
    try {
      using log = options.facts(session, state.through)
      for (const event of log) { apply(state, session, event, rules); state.through = event.seq + 1; options.cache.worked(stateKey) }
      state.through = log.length
      return state
    } catch (error) { options.cache.invalidate(session, stateKey); throw error }
  }
  function selected(sessionId?: string) {
    if (sessionId === undefined) return options.sessions.list()
    const session = options.sessions.get(sessionId)
    return session ? [session] : []
  }
  return {
    async observe(session: S, _event: unknown, _route: unknown, rules: readonly OutputFeedbackRule<D>[]) { read(session, rules) },
    collect(session: S, request: FeedbackRoute & { purpose?: string }, rules: readonly OutputFeedbackRule<D>[]): OutputFeedbackSegment<M>[] {
      if ((request.purpose ?? 'conversation') !== 'conversation') return []
      const state = read(session, rules), segments: OutputFeedbackSegment<M>[] = [], used = new Set<string>()
      const held = new Set([...reservations.values()].filter(value => value.sessionId === String(session.id)).flatMap(value => [...value.keys]))
      for (const rule of rules) {
        if (rule.trigger !== 'output-pattern' || !sameRoute(rule, request)) continue
        const ownKey = keyFor(String(session.id), rule)
        for (const [key, episode] of state.episodes) {
          if (key !== ownKey && !(rule.carryFromOtherRoute && !sameRoute(episode.route, request))) continue
          const pending = episode.pending
          if (!pending || pending.deliveries >= pending.maxDeliveries || used.has(key) || held.has(key)
            || !options.eligible(String(session.id), rule.ruleId, pending.sourceSeqs)) continue
          used.add(key)
          const values = { boundModelLabel: `${request.provider}/${request.model}`, sourceModel: `${episode.route.provider}/${episode.route.model}`,
            H: pending.sample.H, K: pending.sample.K, N: pending.sample.N, examples: pending.sample.evidence.map(hit => `“${hit.text}”`).join('、') }
          let text = rule.text
          for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value))
          segments.push({ ruleId: rule.ruleId, version: rule.version, trigger: 'output-pattern', provider: request.provider, model: request.model,
            purpose: 'conversation', text, segmentId: pending.segmentId, sourceRoute: { ...episode.route }, sourceSeqs: [...pending.sourceSeqs],
            metrics: structuredClone(pending.sample), feedbackKey: key })
        }
      }
      return segments
    },
    async reserve(session: S, segments: readonly { ruleId?: string; feedbackKey?: string }[], callId: string) {
      reservations.set(callId, { sessionId: String(session.id), keys: new Set(segments.flatMap(segment => segment.feedbackKey ? [segment.feedbackKey] : [])) })
    },
    async rollback(_session: S, callId: string) { reservations.delete(callId) },
    async dispatched(session: S, _segments: readonly { ruleId?: string; feedbackKey?: string }[], callId: string, _request?: FeedbackRoute) { reservations.delete(callId); read(session) },
    async flush(sessionId?: string) { await Promise.all(selected(sessionId).map(session => options.sessions.flush(session))) },
    list(sessionId?: string) { return selected(sessionId).flatMap(session => [...read(session).episodes.values()].map(value => structuredClone(value))) },
    clear() { options.cache.clear(stateKey); reservations.clear() },
    async close() { options.cache.clear(stateKey); reservations.clear() },
  }
}
