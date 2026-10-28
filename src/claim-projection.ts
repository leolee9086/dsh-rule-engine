import { z } from 'zod'
import { localWindow } from './event-context.js'
import { recordedDelivery } from './recorded-delivery.js'
import { quotaFor, type ClaimBookValue } from './delivery-claims.js'
const SharedFact = z.object({ key: z.string(), until: z.number().optional() })
const OwnedMessage = z.object({ id: z.string(), source: z.object({
  kind: z.literal('plugin:dsh-context-care:reminder'),
  reminder: z.object({ key: z.string(), candidateId: z.string(), sessionId: z.string().optional(),
    shared: SharedFact.nullable().optional(), handoff: z.object({ actionId: z.string().optional() }).optional() }),
  contextCareTrace: z.object({ sourceId: z.string(), ruleId: z.string(), rule: z.unknown(),
    evidence: z.object({ activationId: z.string().optional(),
      event: z.object({ clock: z.object({ at: z.number() }).optional() }).optional(),
      clock: z.object({ at: z.number() }).optional() }).optional() }).optional(),
}) })
const Owner = z.object({ source: z.object({ kind: z.string() }) })

/** Fold only native inbox/message facts; rules are never compiled during recovery. */
export function recordDeliveryClaim(book: ClaimBookValue, chargedActivations: Set<string>, sessionId: string, value: unknown, status: 'reserved' | 'consumed', now: number): void {
  if (Owner.safeParse(value).data?.source.kind !== 'plugin:dsh-context-care:reminder') return
  const message = OwnedMessage.parse(value), { reminder, contextCareTrace: trace } = message.source
  let shared = reminder.shared
  if (shared === undefined) {
    if (!trace) throw new Error('reminder-shared-evidence-missing')
    const actionId = reminder.handoff?.actionId ?? 'model'
    const { model, timeWindow } = recordedDelivery(trace.rule, actionId)
    if (!model.shared) return
    if (trace.evidence?.activationId && chargedActivations.has(trace.evidence.activationId)) return
    const clock = trace.evidence?.event?.clock?.at ?? trace.evidence?.clock?.at
    const window = localWindow(timeWindow, clock)
    shared = quotaFor({ sourceId: trace.sourceId, ruleId: trace.ruleId, actionId, rule: { actions: [{ id: actionId, delivery: { model } }] }, ...(window ? { window } : {}) })
  }
  if (!shared || shared.until !== undefined && shared.until <= now) return
  let bucket = book.buckets.find(item => item.key === shared.key)
  if (!bucket) { bucket = { key: shared.key, ...(shared.until === undefined ? {} : { until: shared.until }), claims: [] }; book.buckets.push(bucket) }
  const previous = bucket.claims.find(claim => claim.messageId === message.id)
  if (previous) { if (status === 'consumed') previous.status = status }
  else bucket.claims.push({ candidateId: reminder.candidateId, sessionId: reminder.sessionId ?? sessionId, messageId: message.id, status })
  chargedActivations.add(reminder.candidateId)
}
/** Only native message commits may introduce consumed claims. */
export function validateDeliveryClaims(current: ClaimBookValue, next: ClaimBookValue): void {
  const committed = new Set(current.buckets.flatMap(bucket => bucket.claims.filter(claim => claim.status === 'consumed').map(claim => claim.messageId)))
  for (const bucket of next.buckets) for (const claim of bucket.claims) if (claim.status === 'consumed' && !committed.has(claim.messageId)) throw new Error('reminder-shared-delivery-not-committed')
}
