import { isRecord } from './guard.js'
import type { NormalizedRuleV2 } from './block-rules.js'
import type { EngineRuntime } from './runtime-types.js'

export interface ObservationEvent { seq: number; type: string; data?: { interrupted?: unknown } }
const displayTypes = ['assistant/message', 'user/message', 'system/message', 'tool/result']
const seqOf = (value: unknown) => isRecord(value) && typeof value.seq === 'number' ? value.seq : -1

/** 自动处理只观察真实来源准入之后的事件；显式历史展示不消费这些水位。 */
export function observationPolicy(runtime: EngineRuntime, active: readonly NormalizedRuleV2[], admissions: ReadonlyMap<NormalizedRuleV2, number>, admitted: number, through: number) {
  const display = active.filter(rule => rule.on.includes('display.render'))
  const output = active.filter(rule => ['output.complete', 'tool.result'].some(stage => rule.on.includes(stage)))
  const firstAdmission = (selected: readonly NormalizedRuleV2[]) => Math.min(...selected.map(rule => {
    const seq = admissions.get(rule)
    if (seq === undefined) throw new Error('rule-admission-unavailable')
    return seq
  }))
  const lastSeq = Math.max(seqOf(runtime.state.$observed), admitted, firstAdmission(output))
  const displaySeq = Math.max(seqOf(runtime.state.$displayObserved), admitted, firstAdmission(display))
  return { display, output, lastSeq, displaySeq, active: display.length > 0 || output.length > 0,
    start: Math.min(display.length ? displaySeq + 1 : through, output.length ? lastSeq + 1 : through),
    displayEvents<E extends ObservationEvent>(events: readonly E[]): E[] { return events.filter(event => event.seq > displaySeq && displayTypes.includes(event.type)) },
    outputEvents<E extends ObservationEvent>(events: readonly E[]): E[] { return events.filter(event => event.seq > lastSeq && (event.type === 'assistant/message' && !event.data?.interrupted || event.type === 'tool/result')) },
  }
}
export function acknowledgeObservation(runtime: EngineRuntime, kind: 'display' | 'output', seq: number, assessment: string): void {
  runtime.state[kind === 'display' ? '$displayObserved' : '$observed'] = { seq, assessment }
}
export function markDisplayChange(runtime: EngineRuntime, seq: number, token: string): void {
  const previous = runtime.state.$displayMarkers
  if (previous !== undefined && !Array.isArray(previous)) throw new Error('display-markers-must-be-array')
  runtime.state.$displayMarkers = [...(previous ?? []).filter((value: unknown) => !isRecord(value) || value.seq !== seq), { seq, token }].slice(-256)
}
