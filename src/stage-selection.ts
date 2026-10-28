import type { NormalizedRuleV2, RuleEvent, V2Action } from './block-rules.js'
import type { PlanningDecision } from './planning-types.js'
import { indexFirstRules } from './request-rule-index.js'

/** 一次同步策略目录内挑选动作；不跨 await 保存 available/enabled 结论。 */
export function selectStageRules(rules: readonly NormalizedRuleV2[], select: (sourceId: string, ruleId: string, actionId: string) => PlanningDecision, stage?: string): NormalizedRuleV2[] {
  return rules.map(rule => ({ ...rule, actions: rule.actions.filter(action => (stage === undefined || action.stage === stage)
    && select(rule.sourceId, rule.id, action.id).enabled) })).filter(rule => rule.actions.length)
}
/** 工具过滤只产出已匹配的拒绝动作；原生 tools 负责执行拒绝并保留审计。 */
export function selectToolDenial(rules: readonly NormalizedRuleV2[], events: readonly RuleEvent[], decision: (event: RuleEvent, action: V2Action) => PlanningDecision) {
  const byRule = indexFirstRules(rules)
  for (const event of events) {
    const rule = byRule.get(JSON.stringify([event.sourceId, event.ruleId]))
    if (!rule) throw new Error('tool-rule-unavailable')
    for (const action of rule.actions) if (action.kind === 'filter' && action.stage === 'tool.before-execute' && decision(event, action).enabled) return { event, action }
  }
  return undefined
}
export function assertPlanCurrent(planned: { token: string; stage?: string; turnId?: string }, token: string, turnId: string): void {
  if (planned.token !== token) throw Object.assign(new Error('workbench-changed-before-dispatch'), { code: 'CONTROL_CHANGED' })
  if (planned.stage === 'request.assemble' && planned.turnId !== turnId) throw Object.assign(new Error('workbench-turn-changed-before-dispatch'), { code: 'CONTROL_CHANGED' })
}
