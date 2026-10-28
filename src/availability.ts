import { compactExecutorRef } from './action-runs.js'
import { dispatchKey } from './runtime-policy.js'
import { readActionState } from './entry-lifecycle.js'
import type { V2Action, NormalizedRuleV2 } from './block-rules.js'
import type { EngineRuntime } from './runtime-types.js'
export interface Availability { available: boolean; reason?: string }
export function actionAvailability(action: V2Action, { rule, runtime, detectorAvailable, toolArgumentsMutable = false, executorAvailable }: {
  rule?: NormalizedRuleV2
  runtime: EngineRuntime
  detectorAvailable(rule: NormalizedRuleV2, stage: string): boolean
  toolArgumentsMutable?: boolean
  executorAvailable(ref?: string): boolean
}): Availability {
  if (rule?.match.kind === 'detector' && !detectorAvailable(rule, action.stage)) return { available: false, reason: 'detector-unavailable' }
  const held = rule && readActionState(runtime.state[dispatchKey({ sourceId: rule.sourceId, ruleId: rule.id, ruleRevision: rule.revision }, action)])
  if (held?.status === 'unknown') return { available: false, reason: typeof held.reason === 'string' ? held.reason : undefined }
  if (action.stage === 'display.render') {
    if (rule?.select.view === 'model' || rule?.select.crossBlock) return { available: false, reason: 'display-requires-single-original-or-display-block' }
    if (action.patch) return { available: false, reason: 'display-tool-argument-patch-unavailable' }
    if (action.target?.lifetime && action.target.lifetime !== 'request' || action.target?.anchor === 'depth' && (action.target.depth ?? 0) > 1) return { available: false, reason: 'display-message-target-unavailable' }
    return { available: true }
  }
  if (action.stage === 'tool.before-execute' && action.kind !== 'filter' && !toolArgumentsMutable) return { available: false, reason: 'host-tool-arguments-immutable' }
  if (['program', 'tool', 'job', 'compact'].includes(action.kind)) return executorAvailable(action.kind === 'compact' ? compactExecutorRef : action.executorRef)
    ? { available: true } : { available: false, reason: action.kind === 'compact' ? 'compaction-tool-unavailable' : 'executor-unavailable' }
  return { available: true }
}
