import { z } from 'zod'
import { REMINDER_DOMAIN, SessionState, type StateValue } from './event-state.js'
import { isRecord } from './guard.js'

const Receipt = z.object({ id: z.string(), sourceId: z.string(), ruleId: z.string(),
  status: z.enum(['pending', 'reserved', 'delivered', 'discarded']), messageId: z.string().optional(), rule: z.json() })
/** Retire noncanonical disposable candidates without evaluating their declarations.
 * Dedupe/window receipts and uncertain message identities remain durable facts. */
export function restoreDeliveryState(input: unknown, at: number) {
  const wire = REMINDER_DOMAIN.tables.sessions.valueSchema.parse(input)
  const candidates = [], retired = []
  for (const value of wire.candidates) {
    const receipt = Receipt.parse(value)
    if (isRecord(receipt.rule) && receipt.rule.schemaVersion === 2) candidates.push(value)
    else {
      const { rule, ...identity } = receipt
      retired.push({ ...identity, ...(isRecord(rule) && typeof rule.format === 'string' ? { format: rule.format } : {}) })
    }
  }
  // A malformed canonical declaration is corruption, never silent retirement.
  const state = SessionState.parse({ ...wire, candidates })
  if (retired.length) state.diagnostics.push({ at, status: 'retired-candidates',
    message: '非统一声明的临时候选已停止投递；去重、窗口回执与消息身份保留。', candidates: retired })
  return { state, changed: retired.length > 0 }
}
export async function restoreDeliveryEntries(entries: Iterable<readonly [string, unknown]>,
  save?: (id: string, state: StateValue) => Promise<unknown> | void, at = Date.now()) {
  const restored = [...entries].map(([id, input]) => {
    try { return { id, ...restoreDeliveryState(input, at) } }
    catch (cause) { throw new Error(`reminder-state-restore-failed: ${id}`, { cause }) }
  })
  for (const { id, state, changed } of restored) if (changed && save) await save(id, state)
  return restored.map(({ id, state }): readonly [string, StateValue] => [id, state])
}
