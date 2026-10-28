import { setImmediate as yieldToHost } from 'node:timers/promises'
import { recordDeliveryClaim, validateDeliveryClaims } from './claim-projection.js'
import type { ClaimBookValue } from './delivery-claims.js'
import type { PlanningCachePort, PlanningCacheKey } from './planning-cache.js'

export interface ClaimMessage { id: string; source: { kind: string; reminder?: { shared?: unknown } } }
export type ClaimFact<Message extends ClaimMessage> =
  | { type: 'user/message'; seq: number; data: Message }
  | { type: 'agent/inbox/spliced'; seq: number; data: { inserted: readonly Message[]; outcome?: string } }
export type ClaimFactType = ClaimFact<ClaimMessage>['type']
export interface ClaimRead<Session, Message extends ClaimMessage> extends Disposable {
  readonly length: number
  select(types: readonly ClaimFactType[], fromSeq: number): Iterable<ClaimFact<Message>>
  prepare(): Session
}
export interface ClaimRuntimeOptions<Session extends object, Message extends ClaimMessage> {
  cache: PlanningCachePort
  getSession(sessionId: string): Session | undefined
  read(sessionId: string): Promise<ClaimRead<Session, Message>>
  listSessions(): Promise<Iterable<string>>
  inbox(session: Session): readonly Message[]
  now?: () => number
}

/** Cross-session ledger policy. The Host supplies native reads and owns cache storage. */
export function createClaimRuntime<Session extends object, Message extends ClaimMessage>(options: ClaimRuntimeOptions<Session, Message>) {
  const now = options.now ?? Date.now
  let book: ClaimBookValue = { buckets: [] }
  let ready: Promise<void> | undefined
  let lane: Promise<unknown> = Promise.resolve()
  let closed = false
  let observationFailure: unknown
  const dirty = new Set<string>(), chargedActivations = new Set<string>(), accepted = new Map<string, Set<string>>()
  const cursorKey: PlanningCacheKey<Session, { through: number }> = options.cache.define('reminder-shared-claim-cursor',
    'Native Session identity and successful shared-claim replay cursor.', () => ({ through: 0 }))
  const ownsQuota = (message: Message) => message.source.kind === 'plugin:dsh-context-care:reminder' && message.source.reminder?.shared !== null
  function record(sessionId: string, value: Message, status: 'reserved' | 'consumed') {
    recordDeliveryClaim(book, chargedActivations, sessionId, value, status, now())
  }
  function readInbox(session: Session, id: string, canceled = false) {
    const messages = options.inbox(session).filter(ownsQuota)
    const present = new Set(messages.map(message => String(message.id)))
    if (canceled) {
      const removed = new Set([...(accepted.get(id) ?? [])].filter(messageId => !present.has(messageId)))
      // A native commit is irreversible. Only outstanding accepted reservations release.
      for (const bucket of book.buckets) bucket.claims = bucket.claims.filter(claim =>
        claim.status === 'consumed' || !removed.has(claim.messageId))
      book.buckets = book.buckets.filter(bucket => bucket.claims.length > 0)
    }
    for (const message of messages) record(id, message, 'reserved')
    if (present.size) accepted.set(id, present)
    else accepted.delete(id)
  }
  async function readSession(id: string) {
    using log = await options.read(id)
    if (closed) throw new Error('reminder-claims-closed')
    let inboxChanged = false, processed = 0
    const live = options.getSession(id), cursor = live ? options.cache.use(live, cursorKey) : undefined
    for (const event of log.select(['user/message', 'agent/inbox/spliced'], cursor?.through ?? 0)) {
      if (event.type === 'user/message') record(id, event.data, 'consumed')
      else if (event.data.inserted.some(ownsQuota)) inboxChanged = true
      if (++processed % 2048 === 0) { await yieldToHost(); if (closed) throw new Error('reminder-claims-closed') }
    }
    // A dormant log without reminder insertions needs no detached Session replay.
    if (live && cursor) { readInbox(live, id); cursor.through = log.length }
    else if (inboxChanged) readInbox(log.prepare(), id)
  }
  async function initialize() {
    // Lifetime quota includes dormant sessions, not just live agents.
    for (const id of await options.listSessions()) { dirty.delete(id); await readSession(id) }
  }
  return {
    observe(sessionId: string, session: Session, event: ClaimFact<Message>) {
      if (closed) return
      try {
        if (event.type === 'user/message') record(sessionId, event.data, 'consumed')
        else if (accepted.has(sessionId) || event.data.inserted.some(ownsQuota)) {
          readInbox(session, sessionId, event.data.outcome === 'canceled')
        }
      } catch (error) { observationFailure = error; throw error }
    },
    created(sessionId: string) { if (!closed) dirty.add(sessionId) },
    /** Publish a checked transition atomically after all native facts are current. */
    update(change: (current: ClaimBookValue) => ClaimBookValue): Promise<ClaimBookValue> {
      const result = lane.then(async () => {
        if (closed) throw new Error('reminder-claims-closed')
        if (observationFailure) throw observationFailure
        ready ??= initialize().catch(error => { ready = undefined; throw error })
        await ready
        while (dirty.size) {
          const ids = [...dirty]; dirty.clear()
          for (const id of ids) await readSession(id)
        }
        if (closed) throw new Error('reminder-claims-closed')
        if (observationFailure) throw observationFailure
        const next = change(structuredClone(book))
        validateDeliveryClaims(book, next)
        book = next
        return structuredClone(book)
      })
      lane = result.catch(() => { /* Each caller owns its failure; later updates may retry. */ })
      return result
    },
    async close() {
      closed = true
      await lane
      book = { buckets: [] }; dirty.clear(); chargedActivations.clear(); accepted.clear()
      options.cache.clear(cursorKey)
    },
  }
}
