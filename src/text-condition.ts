import type { ConditionNode } from './block-rules.js'
import type { RuleWhen } from './types.js'

/** 原有文本声明在归一化后编译成共同条件节点；标签保留公开的不命中原因。 */
export function textConditions(when: RuleWhen): { reason: string; condition: ConditionNode }[] {
  const steps: { reason: string; condition: ConditionNode }[] = []
  for (const field of ['provider', 'model', 'purpose'] as const) {
    const pattern = when[field]
    if (typeof pattern === 'string') steps.push({ reason: field, condition: { kind: 'glob', field, pattern } })
  }
  if (when.tool !== undefined) steps.push({ reason: 'tool', condition: { kind: 'glob', field: 'tool.name', pattern: typeof when.tool === 'string' ? when.tool : [...when.tool] } })
  if (when.args !== undefined) steps.push({ reason: 'args', condition: { kind: 'arguments', field: 'tool.args', contains: Object.fromEntries(Object.entries(when.args).map(([key, value]) => [key, typeof value === 'string' ? value : [...value]])) } })
  if (when.idle !== undefined) steps.push({ reason: 'idle', condition: { kind: 'idle', ...when.idle } })
  if (when.numbers !== undefined) steps.push({ reason: 'numbers', condition: { kind: 'numbers', values: Object.fromEntries(Object.entries(when.numbers).map(([key, value]) => [key, { ...value }])) } })
  if (when.said !== undefined) steps.push({ reason: 'said', condition: { kind: 'text', field: 'userText', pattern: when.said } })
  if (when.produced !== undefined) steps.push({ reason: 'produced', condition: { kind: 'text', field: 'assistantText', pattern: when.produced } })
  if (when.condition !== undefined) steps.push({ reason: 'condition', condition: when.condition })
  return steps
}
