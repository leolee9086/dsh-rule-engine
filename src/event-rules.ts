import { z } from 'zod'
import { indexRequestActions } from './request-action-order.js'
import { normalizeRuleV2, normalizeCondition, type NormalizedRuleV2, type V2Action, type ConditionNode } from './block-rules.js'
import { compileSnapshotCondition } from './snapshot-conditions.js'
import { EventSelector, Recipient, DeliveryConfig, type ActionDelivery, type EventSelection } from './event-policy.js'
import type { CountLimitValues } from './count-condition.js'
import { parseOrThrow } from './schema-error.js'
import { selectorPaths, sessionEventShape, unresolvableSegment } from './event-selectors.js'
import type { EventFieldShape } from './generated/event-field-shape.js'

/** 事件入口是同一阶段规则入口的导出别名。 */
export { normalizeRuleV2 as normalizeEventRule } from './block-rules.js'
export const EventRule = z.unknown().transform((input, context) => {
  try { return normalizeRuleV2(input) }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); return z.NEVER }
})
const Id = z.string().min(1).max(256)
export const SourceEnvelope = z.object({ sourceId: Id, plugin: Id, sessionId: Id.optional(), scope: Recipient.optional(),
  revision: z.number().int().positive(), rules: z.array(z.unknown()),
  diagnostics: z.array(z.object({ id: z.string(), message: z.string().max(4096) }).strict()).default([]),
}).strict()
export const EventSource = SourceEnvelope.extend({ rules: z.array(EventRule) })
export { DeliveryConfig }
export interface DeclaredEvents { names: ReadonlySet<string>; shapes: ReadonlyMap<string, EventFieldShape> }
export interface EventCatalog { names: ReadonlySet<string>; shapes: ReadonlyMap<string, EventFieldShape> }
export interface DeliveryAction extends V2Action { delivery: ActionDelivery; template: string }
/** 执行项绑定真实规则与真实动作；不转换或保存另一种规则格式。 */
export interface ScheduledAction {
  definition: NormalizedRuleV2
  action: DeliveryAction
  id: string
  stage: string
  event: EventSelection
  condition: ConditionNode
  priority: number
  exclusiveGroup?: string
  title?: string
  recipient?: NormalizedRuleV2['recipient']
  judge?: NormalizedRuleV2['judge']
}
export function deliveryAction(rule: NormalizedRuleV2, actionId = 'model'): DeliveryAction {
  const action = rule.actions.find(value => value.id === actionId)
  if (!action || !action.delivery || typeof action.template !== 'string') throw new Error('event-delivery-action-unavailable')
  return { ...action, delivery: action.delivery, template: action.template }
}
export function compileEventActions(input: unknown, limits?: CountLimitValues, declared?: DeclaredEvents, catalog?: EventCatalog): ScheduledAction[] {
  return scheduleEventRule(parseOrThrow('事件规则无效', () => EventRule.parse(input)), limits, declared, catalog)
}
/** 已规范化规则直接生成调度索引，不再走输入边界。 */
export function scheduleEventRule(definition: NormalizedRuleV2, limits?: CountLimitValues, declared?: DeclaredEvents, catalog?: EventCatalog): ScheduledAction[] {
  const event = EventSelector.parse(definition.event ?? {})
  const conditions: ConditionNode[] = []
  for (const [name, pattern] of Object.entries(event.arguments)) conditions.push(
    normalizeCondition({ kind: 'compare', field: `event.arguments.${name}`, op: 'exists' }),
    normalizeCondition({ kind: 'regex', field: `event.arguments.${name}`, pattern: pattern.regex, flags: pattern.flags.replaceAll('g', '') }))
  const pattern = event.pattern
  if (pattern?.kind === 'literal') conditions.push(normalizeCondition({ kind: 'compare', field: 'event.output.text', op: 'contains', value: pattern.text }))
  if (pattern?.kind === 'keywords') conditions.push(normalizeCondition({ kind: 'keywords', field: 'event.output.text', values: pattern.values, mode: pattern.mode.toUpperCase(), caseSensitive: true }))
  if (pattern?.kind === 'regex') conditions.push(normalizeCondition({ kind: 'regex', field: 'event.output.text', pattern: pattern.regex, flags: pattern.flags.replaceAll('g', '') }))
  conditions.push(definition.match)
  if (definition.on.includes('session.event')) {
    const name = event.eventType
    if (!name || !catalog?.names.has(name) && !declared?.names.has(name)) throw new Error(`事件规则引用了未声明的事件类型 ${name}`)
    const shape = sessionEventShape(declared?.shapes.get(name) ?? catalog?.shapes.get(name) ?? 'any')
    for (const path of selectorPaths(definition.match)) {
      const segment = unresolvableSegment(shape, path)
      if (segment !== undefined) throw new Error(`条件字段 ${path} 不存在于事件 ${name} 的载荷中（缺少 ${segment}）`)
    }
  }
  const condition = compileSnapshotCondition({ kind: 'all', conditions }, limits)
  const ordered = [...indexRequestActions(definition.actions).values()].flatMap(stage => stage.order)
  return ordered.filter(action => action.delivery !== undefined).map(value => {
    const action = deliveryAction(definition, value.id)
    if ((action.stage === 'tool.succeeded' || action.stage === 'tool.failed' || action.stage === 'tool.before-execute') && !event.tool) throw new Error('tool event requires event.tool')
    if (action.stage === 'tool.failed' && !event.error) throw new Error('tool.failed requires event.error.code')
    if (action.stage === 'tool.succeeded' && event.error) throw new Error('tool.succeeded cannot declare event.error')
    if (action.stage === 'request.before' && (event.tool !== undefined || event.error !== undefined || Object.keys(event.arguments).length || event.pattern !== undefined || event.blockTypes !== undefined || event.eventType !== undefined)) throw new Error('request.before cannot declare tool or output selectors')
    if (action.stage === 'assistant.output' && (!event.blockTypes?.length || !event.pattern && definition.match.kind === 'always')) throw new Error('assistant.output requires blockTypes and a condition or pattern')
    return { definition, action, id: definition.id, stage: action.stage, event, condition, priority: definition.priority,
      ...(definition.title === undefined ? {} : { title: definition.title }), ...(definition.exclusiveGroup === undefined ? {} : { exclusiveGroup: definition.exclusiveGroup }),
      ...(definition.recipient === undefined ? {} : { recipient: definition.recipient }), ...(definition.judge === undefined ? {} : { judge: definition.judge }) }
  })
}
