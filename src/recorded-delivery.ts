import { z } from 'zod'
import { isRecord } from './guard.js'

// Read only the parameters retained by a real message. Historical snapshots are
// evidence, never executable declarations: no schema/version upgrade runs here.
const Model = z.object({ once: z.string().optional(), shared: z.discriminatedUnion('reset', [
  z.object({ reset: z.literal('lifetime'), lifetime: z.string(), limit: z.number() }),
  z.object({ reset: z.literal('window'), limit: z.number() }),
]).optional(), sticky: z.object({ clock: z.enum(['main-request', 'human-turn']), cooldown: z.number(), lifetime: z.number() }).optional() })
const Window = z.object({ start: z.string(), end: z.string() }).optional()
export function recordedDelivery(rule: unknown, actionId = 'model') {
  if (!isRecord(rule)) throw new Error('delivery-recorded-rule-missing')
  if (Array.isArray(rule.actions)) {
    const action = rule.actions.find(value => isRecord(value) && value.id === actionId)
    if (!isRecord(action) || !isRecord(action.delivery)) throw new Error('delivery-recorded-action-missing')
    return { model: Model.parse(action.delivery.model), timeWindow: Window.parse(isRecord(rule.event) ? rule.event.timeWindow : undefined),
      stage: typeof action.stage === 'string' ? action.stage : undefined }
  }
  // Earlier messages retained these exact delivery parameters before handoffs
  // carried explicit facts. Only the committed message can reach this branch.
  const effect = isRecord(rule.effect) ? rule.effect : rule
  if (!isRecord(effect.deliver)) throw new Error('delivery-recorded-policy-missing')
  return { model: Model.parse(effect.deliver.model), timeWindow: Window.parse(isRecord(rule.when) ? rule.when.timeWindow : undefined),
    stage: typeof rule.on === 'string' ? rule.on : undefined }
}
export function recordedDeliveryStage(rule: unknown, actionId = 'model'): string | undefined {
  if (!isRecord(rule)) return undefined
  if (Array.isArray(rule.actions)) {
    const action = rule.actions.find(value => isRecord(value) && value.id === actionId)
    return isRecord(action) && typeof action.stage === 'string' ? action.stage : undefined
  }
  return typeof rule.on === 'string' ? rule.on : undefined
}
