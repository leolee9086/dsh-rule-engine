import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { actionRunRecords } from './run-records.js'
import { isRecord } from './guard.js'
import type { EngineRuntime } from './runtime-types.js'
import type { NormalizedRuleV2 } from './block-rules.js'

export interface RuleFailure { message: string; diagnostic: unknown }
/** 重复失败只聚合诊断和源序号，不能伪装成正常未命中。 */
export function recordRuleFailure(runtime: EngineRuntime, error: RuleFailure, sourceSeqs: readonly number[] = [], kind = 'matching', now = Date.now()): void {
  const diagnostic = z.object({ operationId: z.string(), stage: z.string(), rules: z.array(z.object({ sourceId: z.string(), ruleId: z.string() }).catchall(z.json())),
    blockCount: z.number(), inputBytes: z.number().optional() }).catchall(z.json()).parse(JSON.parse(JSON.stringify(error.diagnostic)))
  const group = JSON.stringify([diagnostic.stage, error.message, diagnostic.rules])
  const previous = actionRunRecords(runtime).slice().reverse().find(run => run.kind === kind && run.group === group)
  if (previous) {
    previous.updatedAt = now; previous.count = typeof previous.count === 'number' ? previous.count + 1 : 1; previous.result = diagnostic
    previous.sourceSeqs = [...new Set([...(previous.sourceSeqs ?? []), ...sourceSeqs])].slice(-128)
  } else runtime.runs.push({ id: diagnostic.operationId, group, kind, status: 'failed',
    sourceId: diagnostic.rules[0]?.sourceId ?? 'dsh-context-care', ruleId: diagnostic.rules[0]?.ruleId ?? '', actionId: '', reason: error.message,
    delivery: 'not-requested', createdAt: now, updatedAt: now, count: 1, sourceSeqs: [...sourceSeqs],
    inputs: { stage: diagnostic.stage, rules: diagnostic.rules, inputBytes: diagnostic.inputBytes ?? null, blockCount: diagnostic.blockCount }, result: diagnostic })
}
const fixedPatchReasons = ['rules-v2: block cannot be text-patched', 'rules-v2: stale block anchor', 'rules-v2: cross-block replacement requires per-block patches',
  'rules-v2: invalid patch range', 'rules-v2: replacement must be text']
const fixedDisplayReasons = ['display-rule-unavailable', 'display-dependency-cycle', 'display-cross-block-write-unavailable', 'display-action-output-budget-exceeded',
  'display-text-range-unavailable', 'display-opaque-filter-denied', 'display-target-unavailable', 'display-message-depth-unavailable', 'display-anchor-unavailable',
  'display-injection-budget-exceeded', 'display-result-budget-exceeded']
/** 对外保留固定故障类别，原始异常只放 cause，避免把模板内容写入运行诊断。 */
export function displayPlanningFailure(cause: unknown, rules: readonly NormalizedRuleV2[], blockCount: number) {
  const text = cause instanceof Error || isRecord(cause) ? cause.message : undefined
  const reason = typeof text === 'string' && [...fixedDisplayReasons, ...fixedPatchReasons].includes(text) ? text : 'display-planning-failed'
  return Object.assign(new Error(reason, { cause }), { code: 'CONTEXT_CARE_DISPLAY_FAILED', diagnostic: {
    operationId: randomUUID(), stage: 'display.render', phase: 'planning', failureClass: cause instanceof Error ? cause.name : 'Error',
    rules: rules.map(rule => ({ sourceId: rule.sourceId, ruleId: rule.id, revision: rule.revision })), blockCount,
  } })
}
