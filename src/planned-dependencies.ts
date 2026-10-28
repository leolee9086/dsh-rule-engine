import type { PlannedAction, ScheduledAction, PlanningRecord } from './planning-types.js'

/** 文本程序执行后，只发布实际完成的动作；延迟副作用也必须服从同一次依赖裁决。 */
export function settlePlannedDependencies(records: PlanningRecord[], applied: PlannedAction[], scheduled: ScheduledAction[]) {
  const key = (item: { sourceId?: string; ruleId?: string; occurrenceId?: string; actionId: string }) => JSON.stringify([item.sourceId, item.ruleId, item.occurrenceId, item.actionId])
  const byId = new Map(records.map(record => [key(record), record]))
  const successful = new Set<string>()
  for (const item of applied) {
    const identity = { sourceId: item.event.sourceId, ruleId: item.event.ruleId, occurrenceId: item.event.occurrenceId, actionId: item.action.id }
    const record = byId.get(key(identity))
    if (record?.status === 'skipped') continue
    if (item.action.dependsOn.some(actionId => !successful.has(key({ ...identity, actionId })))) {
      if (record) { record.status = 'skipped'; record.reason = 'dependency-not-planned' }
      continue
    }
    successful.add(key(identity))
  }
  const admitted = (item: PlannedAction | ScheduledAction) => successful.has(key({ sourceId: item.event.sourceId, ruleId: item.event.ruleId, occurrenceId: item.event.occurrenceId, actionId: item.action.id }))
  return { applied: applied.filter(admitted), scheduled: scheduled.filter(admitted) }
}
