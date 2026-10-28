import { z } from 'zod'
import { parseInput } from './input-schema.js'
import { snapshotMacros, transformText, TextTransform } from './text-transform.js'
import { normalizeCondition, matchConditionV2, type V2Block, type V2Action } from './block-rules.js'

const Task = z.object({ id: z.string(), text: z.string(), steps: z.array(z.object({ transform: TextTransform,
  snapshot: z.record(z.string(), z.unknown()), condition: z.unknown().optional(), dependsOn: z.array(z.number().int().nonnegative()).default([]), maxChars: z.number().optional() }).strict()) }).strict()
export type TextTransformTask = z.infer<typeof Task>
const Output = z.array(z.object({ id: z.string(), text: z.string(), steps: z.array(z.object({ before: z.string(), after: z.string(), applied: z.boolean() }).strict()) }).strict())
export type TextTransformOutput = z.infer<typeof Output>
export interface TextTransformExecutor {
  (input: { textTransforms: TextTransformTask[] }, signal?: AbortSignal): Promise<unknown>
}
/** 同步调用与可终止 Worker 执行完全相同的变换程序。 */
export function executeTextTransforms(input: unknown): TextTransformOutput {
  return parseInput(z.array(Task), input, 'text program').map(task => {
    let text = task.text
    const outcomes: boolean[] = []
    const steps = task.steps.map((step, index) => {
      const before = text
      if (step.dependsOn.some(parent => parent >= index || outcomes[parent] !== true)) { outcomes.push(false); return { before, after: before, applied: false } }
      const block = typeof step.snapshot.block === 'object' && step.snapshot.block !== null ? step.snapshot.block : {}
      if (step.condition !== undefined && !matchConditionV2(normalizeCondition(step.condition), { ...step.snapshot, block: { ...block, text } }).ok) { outcomes.push(false); return { before, after: before, applied: false } }
      const result = transformText(step.transform, text, snapshotMacros(step.snapshot))
      text = result.text
      if (step.maxChars !== undefined && text.length > step.maxChars) throw new Error('action-output-budget-exceeded')
      outcomes.push(result.matched)
      return { before, after: text, applied: result.matched }
    })
    return { id: task.id, text, steps }
  })
}
/** 基线补丁先按原坐标裁决；顺序变换读取其输出，二者的坐标不混用。
 * 真正执行可交给有预算的 Worker；结果校验完成后才能修改本次提案记录。 */
export function createTextTransformPlan() {
  const actions = new Map<string, { action: V2Action; snapshot: Record<string, unknown>; record: { status: string; reason?: string; before?: unknown; after?: unknown; sourceId?: string; ruleId?: string; occurrenceId?: string } }[]>()
  return {
    add(block: V2Block & { replayState?: unknown; source?: { replayState?: unknown } }, action: V2Action, snapshot: Record<string, unknown>, record: { status: string; reason?: string; before?: unknown; after?: unknown; sourceId?: string; ruleId?: string; occurrenceId?: string }) {
      if (!action.transform) throw new Error('text-transform-definition-unavailable')
      if (block.signed || block.replayState !== undefined || block.source?.replayState !== undefined) throw new Error('text-transform-opaque-block-denied')
      const held = actions.get(block.id) ?? []
      held.push({ action, snapshot, record }); actions.set(block.id, held)
    },
    prepare<B extends V2Block>(blocks: readonly B[]) {
      const tasks: TextTransformTask[] = []
      for (const [position, block] of blocks.entries()) {
        const steps = actions.get(block.id)
        if (!steps?.length) continue
        if (typeof block.text !== 'string') throw new Error('text-transform-needs-text-block')
        tasks.push({ id: String(position), text: block.text, steps: steps.map(({ action, snapshot, record }, index) => {
          if (!action.transform) throw new Error('text-transform-definition-unavailable')
          const dependsOn = steps.slice(0, index).flatMap((parent, position) => parent.record.sourceId === record.sourceId && parent.record.ruleId === record.ruleId
            && parent.record.occurrenceId === record.occurrenceId && action.dependsOn.includes(parent.action.id) ? [position] : [])
          return { transform: action.transform, snapshot, dependsOn, ...(action.condition === undefined ? {} : { condition: action.condition }), ...(action.maxChars === undefined ? {} : { maxChars: action.maxChars }) }
        }) })
      }
      return { tasks, finish(raw: unknown): B[] {
        const results = Output.parse(raw)
        if (results.length !== tasks.length) throw new Error('text-transform-output-incomplete')
        const byId = new Map(results.map(result => [result.id, result]))
        if (byId.size !== results.length || tasks.some(task => byId.get(task.id)?.steps.length !== task.steps.length)) throw new Error('text-transform-output-invalid')
        return blocks.map((block, position) => {
          const result = byId.get(String(position))
          if (!result) return block
          const steps = actions.get(block.id) ?? []
          for (const [index, { record }] of steps.entries()) {
            const step = result.steps[index]
            record.before = step.before; record.after = step.after
            if (!step.applied) { record.status = 'skipped'; record.reason = 'no-match' }
          }
          return result.text === block.text ? block : { ...block, text: result.text, raw: { ...block.raw, text: result.text } }
        })
      } }
    },
  }
}
