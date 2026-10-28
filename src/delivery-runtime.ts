import { setImmediate as yieldToHost } from 'node:timers/promises'
import { emptyDeliveryProjection, emptyQueuedDeliveryProjection, applyDeliveryFact, applyQueuedDeliveryFact,
  readDeliveryProjection, deliveryHanded, rememberDeliveryTrigger, queuedDeliveryMessages } from './delivery-projection.js'
import type { DeliveryFactEvent, DeliveryFactMessage, DeliveryFoldPorts, DeliveryProjection, QueuedDeliveryProjection } from './delivery-projection.js'
import type { EventDeliveryState } from './delivery-facts.js'
import type { HandoffRule } from './event-state.js'
import type { PlanningCachePort, PlanningCacheKey } from './planning-cache.js'

export interface DeliverySession { readonly id: string; readonly seq: number; readonly inheritedEventCount: number; readonly firstLiveSeq: number }
export type DeliveryFactType = DeliveryFactEvent<DeliveryFactMessage>['type']
export type DeliveryObservation<Message extends DeliveryFactMessage> = DeliveryFactEvent<Message> | { type: 'other'; seq: number }
export interface DeliveryLog<Message extends DeliveryFactMessage> extends Disposable {
  readonly owner: object
  readonly length: number
  readonly inheritedEventCount: number
  select(types: readonly DeliveryFactType[], fromSeq: number, toSeqExclusive?: number): Iterable<DeliveryFactEvent<Message>>
}
export interface DeliveryCachePort extends PlanningCachePort {
  peek<O extends object, T>(owner: O, key: PlanningCacheKey<O, T>, dependencies?: readonly unknown[]): T | undefined
  invalidate(owner: object, key: object): void
}
export interface DeliveryRuntimeOptions<Session extends DeliverySession, Message extends DeliveryFactMessage> extends DeliveryFoldPorts {
  cache: DeliveryCachePort
  getSession(sessionId: string): Session | undefined
  read(sessionId: string): Promise<DeliveryLog<Message>>
  live(session: Session): DeliveryLog<Message>
  inbox(sessionId: string): readonly Message[]
  now?: () => number
}

/** Incremental delivery recovery. Native log cuts, generations and cache storage remain Host-owned. */
export function createDeliveryRuntime<Session extends DeliverySession, Message extends DeliveryFactMessage>(options: DeliveryRuntimeOptions<Session, Message>) {
  type Projection = DeliveryProjection<Message>
  const cache = options.cache, now = options.now ?? Date.now
  const stateKey: PlanningCacheKey<object, Projection> = cache.define('reminder-deliveries',
    'Exact live Session or immutable cold log owner; successful native fold cursor.',
    (_owner, dependencies) => emptyDeliveryProjection<Message>(Number(dependencies[0])))
  const queuedKey: PlanningCacheKey<Session, QueuedDeliveryProjection<Message>> = cache.define('reminder-queued-input',
    'Native Session identity and committed acceptance cursor.', session => emptyQueuedDeliveryProjection<Message>(session.inheritedEventCount))
  const cached = (session: Session) => cache.peek(session, stateKey, [session.inheritedEventCount])
  const receiptKey: PlanningCacheKey<object, { state: Projection; from: number; through: number; commits: Map<string, number>;
    selected?: { from: number; revision: number; ids: ReadonlySet<string> }; revision: number }> = cache.define('reminder-handoff-receipts',
    'Immutable log owner and covered native suffix; receipt sequence validates each requested anchor.',
    (_owner, dependencies) => ({ state: emptyDeliveryProjection<Message>(Number(dependencies[0])), from: Infinity, through: 0, commits: new Map(), revision: 0 }))
  const pending = new Map<object, DeliveryObservation<Message>[]>(), restoring = new Map<object, Promise<Projection>>()
  let closed = false
  function apply(projection: Projection, sessionId: string, event: DeliveryObservation<Message>) {
    if (event.type === 'other') projection.cursor = Math.max(projection.cursor, event.seq + 1)
    else applyDeliveryFact(projection, sessionId, event, options)
  }
  async function receipts(sessionId: string, fromSeq: number) {
    using log = await options.read(sessionId)
    if (closed) throw new Error('reminder-deliveries-closed')
    const indexed = cache.use(log.owner, receiptKey, [log.inheritedEventCount]), from = Math.max(fromSeq, log.inheritedEventCount)
    const fold = (start: number, end: number) => {
      for (const event of log.select(['user/message', 'agent/inbox/spliced'], start, end)) {
        indexed.state.cursor = event.seq + 1
        if (event.type === 'user/message') {
          rememberDeliveryTrigger(indexed.state, sessionId, event.data)
          const id = String(event.data.id), prior = indexed.commits.get(id)
          if (prior === undefined || prior < event.seq) { indexed.commits.set(id, event.seq); indexed.revision++ }
        } else if (event.type === 'agent/inbox/spliced') {
          for (const message of event.data.inserted) rememberDeliveryTrigger(indexed.state, sessionId, message)
        }
        cache.worked(receiptKey)
      }
    }
    try {
      if (indexed.from === Infinity) fold(from, log.length)
      else {
        if (from < indexed.from) fold(from, Math.min(indexed.from, log.length))
        if (indexed.through < log.length) fold(Math.max(indexed.from, indexed.through), log.length)
      }
      indexed.from = Math.min(indexed.from, from); indexed.through = Math.max(indexed.through, log.length)
      return { indexed, from, through: log.length }
    } catch (error) { cache.invalidate(log.owner, receiptKey); throw error }
  }
  async function restore(sessionId: string): Promise<Projection> {
    if (closed) throw new Error('reminder-deliveries-closed')
    const session = options.getSession(sessionId), state = session && cached(session)
    if (session && !restoring.has(session) && state?.cursor === session.seq) return state
    using log = await options.read(sessionId)
    if (closed) throw new Error('reminder-deliveries-closed')
    const active = restoring.get(log.owner)
    if (active) return active
    const queued: DeliveryObservation<Message>[] = []
    pending.set(log.owner, queued)
    const task = (async () => {
      const dependencies = [log.inheritedEventCount], next = cache.use(log.owner, stateKey, dependencies)
      try {
        let processed = 0
        for (const event of log.select(['user/message', 'agent/inbox/spliced', 'step/start', 'step/end',
          'turn/start', 'turn/end', 'tool/call', 'tool/result', 'tool/ptc-dispatch'], next.cursor)) {
          apply(next, sessionId, event); cache.worked(stateKey)
          if (++processed % 2048 === 0) { await yieldToHost(); if (closed) throw new Error('reminder-deliveries-closed') }
        }
        next.cursor = Math.max(next.cursor, log.length)
        for (const event of queued) apply(next, sessionId, event)
        return next
      } catch (error) {
        if (!closed && cache.peek(log.owner, stateKey, dependencies) === next) cache.invalidate(log.owner, stateKey)
        throw error
      }
    })()
    restoring.set(log.owner, task)
    try { return await task }
    finally { restoring.delete(log.owner); pending.delete(log.owner) }
  }
  return {
    created(session: Session) {
      if (!closed && session.firstLiveSeq === 0) cache.use(session, stateKey, [session.inheritedEventCount])
    },
    queued(sessionId: string): Message[] {
      if (closed) throw new Error('reminder-deliveries-closed')
      const session = options.getSession(sessionId), full = session && cached(session)
      let accepted = full?.queued
      if (session && full?.cursor !== session.seq) {
        const state = cache.use(session, queuedKey)
        using log = options.live(session)
        try {
          for (const event of log.select(['agent/inbox/spliced', 'user/message'], state.cursor)) {
            if (event.type === 'agent/inbox/spliced' || event.type === 'user/message') applyQueuedDeliveryFact(state, sessionId, event)
            cache.worked(queuedKey)
          }
          state.cursor = log.length; accepted = state.queued
        } catch (error) { cache.invalidate(session, queuedKey); throw error }
      }
      return queuedDeliveryMessages(sessionId, accepted, options.inbox(sessionId))
    },
    observe(session: Session, event: DeliveryObservation<Message>) {
      if (closed) return
      const queued = pending.get(session)
      if (queued) { queued.push(event); return }
      const state = cached(session)
      if (state) {
        try { apply(state, String(session.id), event) }
        catch (error) { cache.invalidate(session, stateKey); throw error }
      }
    },
    currentHumanTurn(sessionId: string): string | undefined {
      const session = options.getSession(sessionId), state = session && cached(session)
      if (closed || !state || !session || restoring.has(session) || state.cursor !== session.seq) return undefined
      return state.humanArrival || state.humanCommit || 'initial'
    },
    async wasHanded(sessionId: string, eventId: string, rule?: HandoffRule, fromSeq?: number): Promise<boolean> {
      if (closed) throw new Error('reminder-deliveries-closed')
      if (fromSeq === undefined) return deliveryHanded(await restore(sessionId), sessionId, eventId, rule)
      const session = options.getSession(sessionId), state = session && cached(session)
      if (session && !restoring.has(session) && state?.cursor === session.seq) return deliveryHanded(state, sessionId, eventId, rule, fromSeq)
      const { indexed, from } = await receipts(sessionId, fromSeq)
      return deliveryHanded(indexed.state, sessionId, eventId, rule, from)
    },
    async humanTurn(sessionId: string): Promise<string> {
      const state = await restore(sessionId)
      return state.humanArrival || state.humanCommit || 'initial'
    },
    async read(sessionId: string, currentHumanId: string, fromSeq?: number): Promise<Omit<EventDeliveryState, 'queued'> & { queued: Message[] }> {
      if (closed) throw new Error('reminder-deliveries-closed')
      if (fromSeq !== undefined) {
        const { indexed, from, through } = await receipts(sessionId, fromSeq)
        if (indexed.selected?.from !== from || indexed.selected.revision !== indexed.revision) {
          const ids = new Set<string>()
          for (const [id, seq] of indexed.commits) if (seq >= from && seq < through) ids.add(id)
          indexed.selected = { from, revision: indexed.revision, ids }
        }
        return { windows: [], stickies: [], ticked: new Set(), committedIds: indexed.selected.ids, humanId: currentHumanId, queued: [] }
      }
      return readDeliveryProjection(await restore(sessionId), currentHumanId, now())
    },
    close() { closed = true; cache.clear(stateKey); cache.clear(queuedKey); cache.clear(receiptKey); pending.clear() },
  }
}
