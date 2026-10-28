import { z } from 'zod'

const Claim = z.object({ candidateId: z.string(), sessionId: z.string(), messageId: z.string(),
  status: z.enum(['reserved', 'consumed']) }).strict()
export const ClaimBook = z.object({ buckets: z.array(z.object({ key: z.string(), until: z.number().optional(),
  claims: z.array(Claim) }).strict()) }).strict()
export type ClaimBookValue = z.infer<typeof ClaimBook>
export type SharedQuota = { reset: 'lifetime'; lifetime: string; limit: number } | { reset: 'window'; limit: number }
export interface QuotaCandidate {
  sourceId: string
  ruleId: string
  // Every effect delivers, so every effect can own a quota.
  rule: { actions: { id: string; delivery?: { model: { shared?: SharedQuota } } }[] }
  actionId?: string
  window?: { id: string; end: number }
}
export interface Reservation {
  key: string
  limit: number
  until?: number
  candidateId: string
  sessionId: string
  messageId: string
}
export interface ClaimOperation {
  reserve?: Reservation[]
  consume?: string[]
  release?: string[]
  at: number
  maxBytes: number
}
const perRecordLayout: 'per-record' = 'per-record'
export const CLAIM_DOMAIN = { name: 'context_care_reminder_claims', version: 1, layout: perRecordLayout,
  tables: { claims: { valueSchema: ClaimBook } } }

/** A lifecycle name survives rule edits; a calendar window supplies its own identity. */
export function quotaFor(candidate: QuotaCandidate) {
  const actionId = candidate.actionId ?? 'model'
  const owner = actionId === 'model' ? [candidate.sourceId, candidate.ruleId] : [candidate.sourceId, candidate.ruleId, actionId]
  const quota = candidate.rule.actions.find(action => action.id === actionId)?.delivery?.model.shared
  if (!quota) return undefined
  if (quota.reset === 'window') {
    if (!candidate.window) throw new Error('shared-window-identity-missing')
    return { key: JSON.stringify([...owner, quota.reset, candidate.window.id]),
      limit: quota.limit, until: candidate.window.end }
  }
  return { key: JSON.stringify([...owner, quota.reset, quota.lifetime]), limit: quota.limit }
}

/** Pure ledger transition, called inside the storage domain's atomic update. */
export function changeClaims(book: ClaimBookValue, { reserve = [], consume = [], release = [], at, maxBytes }: ClaimOperation): ClaimBookValue {
  const consumedStatus: 'consumed' = 'consumed'
  const consumed = new Set(consume), released = new Set(release)
  const next: ClaimBookValue = { buckets: book.buckets.filter(bucket => bucket.until === undefined || bucket.until > at)
    .map(bucket => ({ ...bucket, claims: bucket.claims.flatMap(claim => {
      // A committed delivery always wins over a late rollback.
      if (claim.status === 'consumed' || consumed.has(claim.messageId)) return [{ ...claim, status: consumedStatus }]
      return released.has(claim.messageId) ? [] : [{ ...claim }]
    }) })) }
  for (const item of reserve) {
    if (item.until !== undefined && item.until <= at) continue
    let bucket = next.buckets.find(value => value.key === item.key)
    if (!bucket) {
      bucket = { key: item.key, ...(item.until === undefined ? {} : { until: item.until }), claims: [] }
      next.buckets.push(bucket)
    }
    if (bucket.claims.some(claim => claim.messageId === item.messageId)) continue
    if (bucket.claims.length >= item.limit) continue
    bucket.claims.push({ candidateId: item.candidateId, sessionId: item.sessionId,
      messageId: item.messageId, status: 'reserved' })
  }
  next.buckets = next.buckets.filter(bucket => bucket.claims.length > 0)
  if (Buffer.byteLength(JSON.stringify(next)) > maxBytes) throw new Error('reminder-claim-budget-exceeded')
  return next
}

/** Read acknowledgement from the committed transition result, never from a later snapshot. */
export function hasClaim(book: ClaimBookValue, key: string, messageId: string) {
  return book.buckets.some(bucket => bucket.key === key && bucket.claims.some(claim => claim.messageId === messageId))
}
