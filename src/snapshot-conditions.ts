import { z } from 'zod'
import { matchConditionV2, normalizeCondition, type ConditionNode } from './block-rules.js'
import { isRecord } from './guard.js'
import { CountLimits, type CountLimitValues, type TextSampleValue } from './count-condition.js'
import type { MatchTruth, TextCountResult } from './text-count.js'
import { schemaError } from './schema-error.js'
export { CountLimits, TextSamples } from './count-condition.js'
export type { CountLimitValues, TextSampleValue } from './count-condition.js'

/** 快照条件和块条件使用相同的节点、规范化和求值器。 */
export type SnapshotCondition = ConditionNode
export function compileSnapshotCondition(input: unknown, ceilings: CountLimitValues = CountLimits.parse(undefined)): SnapshotCondition {
  try { return clampCountLimits(normalizeCondition(input), ceilings) }
  catch (error) {
    const fault = schemaError(error, '提醒条件无效')
    throw new Error(`提醒条件无效: ${fault.message}`, { cause: error })
  }
}
/** Worker 的 structured clone 边界重新校验公共节点，不创建另一套条件语义。 */
export function parseSnapshotCondition(input: unknown, ceilings: CountLimitValues): SnapshotCondition {
  return compileSnapshotCondition(input, ceilings)
}
export function clampCountLimits(condition: ConditionNode, ceilings: CountLimitValues): ConditionNode {
  if (condition.kind === 'all' || condition.kind === 'any') {
    const conditions = condition.conditions.map(child => clampCountLimits(child, ceilings))
    return conditions.every((child, index) => child === condition.conditions[index]) ? condition : { ...condition, conditions }
  }
  if (condition.kind === 'not') {
    const inner = clampCountLimits(condition.condition, ceilings)
    return inner === condition.condition ? condition : { ...condition, condition: inner }
  }
  if (condition.kind !== 'count') return condition
  const limits = { maxTextChars: Math.min(condition.limits.maxTextChars, ceilings.maxTextChars),
    maxCandidates: Math.min(condition.limits.maxCandidates, ceilings.maxCandidates),
    maxUnits: Math.min(condition.limits.maxUnits, ceilings.maxUnits), maxEvidence: Math.min(condition.limits.maxEvidence, ceilings.maxEvidence) }
  return Object.entries(limits).every(([key, value]) => Reflect.get(condition.limits, key) === value) ? condition : { ...condition, limits }
}
const Json = z.json()
type JsonValue = z.infer<typeof Json>
const Evidence = z.object({ ok: z.boolean(), ranges: z.array(z.tuple([z.number(), z.number()])), captures: z.record(z.string(), Json), field: z.string().optional() })
export interface SnapshotMatch {
  ok: boolean
  status: MatchTruth
  ranges: [number, number][]
  captures: Record<string, JsonValue>
  measurements: { path: string; field: string; sampleId?: string; result: TextCountResult }[]
  diagnostics: { path: string; message: string }[]
  field?: string
}
/** 同一求值器的三态观察结果；未知证据在 not 下仍然未知。 */
export function evaluateSnapshotCondition(condition: ConditionNode, snapshot: JsonValue, samples: readonly TextSampleValue[] = []): SnapshotMatch {
  if (!isRecord(snapshot)) return { ok: false, status: 'unavailable', ranges: [], captures: {}, measurements: [],
    diagnostics: [{ path: 'condition', message: 'condition-snapshot-must-be-object' }] }
  const found = matchConditionV2(condition, snapshot, undefined, { captureErrors: true, samples })
  return { ...Evidence.parse(found), status: found.status ?? (found.ok ? 'matched' : 'unmatched'),
    measurements: found.measurements ?? [], diagnostics: found.diagnostics ?? [] }
}
