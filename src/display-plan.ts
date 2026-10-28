import { createTextTransformPlan, executeTextTransforms, type TextTransformExecutor } from './text-transform-plan.js'
import { type NormalizedRuleV2, type V2Action, type RuleEvent } from './block-rules.js'
import { indexFirstRules } from './request-rule-index.js'
import { indexRequestActions, type RequestActionStages } from './request-action-order.js'
import { indexDisplayBlocks, mergeDisplayInsertions, type DisplayInsertion } from './display-index.js'
import { createBlockPatchPlan } from './display-patch-plan.js'
import type { BlockPatch } from './patch-types.js'
import type { DisplayBlock, PlanningRecord, PlanningTemplates, PlanningSnapshot, PlanningDecision } from './planning-types.js'

export interface ViewBlock { id: string; seq?: number; path?: string; role: string; type: string; text?: string }
export interface DisplayPlanningAnalysis<B extends DisplayBlock> {
  blocks(blocks: readonly B[]): ReturnType<typeof indexDisplayBlocks<B>>
  rules(rules: readonly NormalizedRuleV2[]): ReadonlyMap<string, NormalizedRuleV2>
  actions(actions: readonly V2Action[]): RequestActionStages<V2Action>
  patchWork(amount: number): void
}
export interface DisplayPlanInput<B extends DisplayBlock> {
  blocks: readonly B[]
  rules: readonly NormalizedRuleV2[]
  events: readonly RuleEvent[]
  templates: PlanningTemplates
  snapshot: PlanningSnapshot
  decision(event: RuleEvent, action: V2Action): PlanningDecision
  withDecisions?<T>(run: (decision: DisplayPlanInput<B>['decision']) => T): T
  maxInjectedChars: number
  maxBytes: number
  analysis?: DisplayPlanningAnalysis<B>
}
const viewBlock = (block: DisplayBlock): ViewBlock => ({ id: block.id, seq: block.seq, path: block.path, role: block.role, type: block.type, text: block.text })

/** 在不可变展示切面上完成动作裁决；输出保持 UTF-16 基线坐标。 */
function prepareDisplay<B extends DisplayBlock>({ blocks, rules, events, templates, snapshot, decision, maxInjectedChars, maxBytes, analysis }: DisplayPlanInput<B>) {
  const indexed = analysis ? analysis.blocks(blocks) : indexDisplayBlocks(blocks), baseline = indexed.baseline
  let patchPlan: ReturnType<typeof createBlockPatchPlan<B, BlockPatch>> | undefined
  const filtered = new Set<string>(), checkedFilters = new Set<string>(), insertions: DisplayInsertion<ViewBlock>[] = [], records: PlanningRecord[] = []
  const transforms = createTextTransformPlan()
  let injectedChars = 0
  const byRule = analysis ? analysis.rules(rules) : indexFirstRules(rules), orders = new Map<readonly V2Action[], RequestActionStages<V2Action>>()
  for (const event of events) {
    const rule = byRule.get(JSON.stringify([event.sourceId, event.ruleId]))
    if (!rule) throw new Error('display-rule-unavailable')
    let stages = analysis ? analysis.actions(rule.actions) : orders.get(rule.actions)
    if (!stages) { stages = indexRequestActions([...new Set(rule.actions.filter(action => action.stage === 'display.render'))]); orders.set(rule.actions, stages) }
    const ordered = stages.get('display.render'), outcomes = new Map<string, boolean>()
    for (const action of ordered?.order ?? []) {
      const record: PlanningRecord = { sourceId: event.sourceId, ruleId: event.ruleId, actionId: action.id, occurrenceId: event.occurrenceId, blockId: event.blockId, ranges: event.ranges, status: 'planned' }
      records.push(record)
      const eligibility = decision(event, action)
      if (!eligibility.enabled || action.dependsOn.some(id => outcomes.get(id) !== true)) {
        record.status = 'skipped'; record.reason = eligibility.enabled ? 'dependency-not-planned' : eligibility.reason
        outcomes.set(action.id, false); continue
      }
      const block = indexed.first(event.blockId)
      if (!block || event.segments) throw new Error('display-cross-block-write-unavailable')
      const context = { ...snapshot, surface: event.block.surface, captures: event.captures, facts: event.facts, block: event.block,
        tool: { name: event.block.raw?.name, arguments: event.block.arguments, result: event.block.raw?.content } }
      const text = action.template === undefined ? undefined : templates.render(action.template, context)
      if (text !== undefined && text.length > (action.maxChars ?? maxInjectedChars)) throw new Error('display-action-output-budget-exceeded')
      if (action.kind === 'replace') {
        if (action.patch || (event.field ?? 'block.text') !== 'block.text' || block.text !== event.block.text) throw new Error('display-text-range-unavailable')
        if (typeof text !== 'string') throw new TypeError('rules-v2: replacement must be text')
        const candidates = (event.ranges.length ? event.ranges : [[0, block.text?.length ?? 0]])
          .map(range => ({ blockId: block.id, actionId: `${event.occurrenceId}:${action.id}`, priority: rule.priority, range, text }))
        patchPlan ??= createBlockPatchPlan(baseline, amount => analysis?.patchWork(amount), id => indexed.same(id))
        if (!patchPlan.accept(candidates)) { record.status = 'skipped'; record.reason = 'overlapping-patch'; outcomes.set(action.id, false); continue }
      } else if (action.kind === 'transform') {
        transforms.add(block, action, context, record)
      } else if (action.kind === 'filter') {
        if (!checkedFilters.has(block.id)) {
          const group = indexed.filterGroup(block)
          if (group.some(candidate => candidate.signed || candidate.replayState !== undefined)) throw new Error('display-opaque-filter-denied')
          group.forEach(candidate => filtered.add(candidate.id)); checkedFilters.add(block.id)
        }
      } else if (action.kind === 'inject') {
        const target = action.target ?? { view: 'display', anchor: 'end', position: 'after' }
        if (target.view !== 'display' || target.lifetime && target.lifetime !== 'request') throw new Error('display-target-unavailable')
        let at: number
        if ((target.anchor ?? 'end') === 'end') at = baseline.length
        else if (target.anchor === 'start') at = 0
        else if (target.anchor === 'depth') {
          if (target.depth === undefined || target.depth > 1) throw new Error('display-message-depth-unavailable')
          at = target.depth === 0 ? baseline.length : 0
        } else {
          at = indexed.position(target.anchor === 'matched' ? block.id : target.anchor ?? '')
          if (at < 0) throw new Error('display-anchor-unavailable')
          if (target.position !== 'before') at++
        }
        if (typeof text !== 'string') throw new Error('display-injection-text-unavailable')
        injectedChars += text.length
        if (injectedChars > maxInjectedChars) throw new Error('display-injection-budget-exceeded')
        insertions.push({ at, priority: rule.priority, block: { id: `display:${event.occurrenceId}:${action.id}`, role: target.role ?? block.role, type: 'text', text } })
      } else throw new Error(`display-action-unavailable:${action.kind}`)
      outcomes.set(action.id, true)
    }
    if (ordered?.cycle) throw new Error('display-dependency-cycle')
  }
  const patched = patchPlan ? patchPlan.finish() : { blocks: baseline, results: [] }
  const textPlan = transforms.prepare(patched.blocks)
  return { tasks: textPlan.tasks, finish: (transformed: unknown) => {
  const output = mergeDisplayInsertions(textPlan.finish(transformed).map(viewBlock), insertions)
  const result = { before: baseline.map(viewBlock), after: output.filter(block => !filtered.has(block.id)), records, patches: patched.results }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) throw new Error('display-result-budget-exceeded')
  return { ...result, changed: JSON.stringify(result.before) !== JSON.stringify(result.after) }
  } }
}

function prepareWithDecisions<B extends DisplayBlock>(input: DisplayPlanInput<B>) {
  return input.withDecisions ? input.withDecisions(decision => prepareDisplay({ ...input, decision })) : prepareDisplay(input)
}
export function planDisplay<B extends DisplayBlock>(input: DisplayPlanInput<B>) {
  const prepared = prepareWithDecisions(input)
  return prepared.finish(executeTextTransforms(prepared.tasks))
}
export async function planDisplayAsync<B extends DisplayBlock>(input: DisplayPlanInput<B>, execute: TextTransformExecutor, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const prepared = prepareWithDecisions(input)
  const result = prepared.tasks.length ? await execute({ textTransforms: prepared.tasks }, signal) : []
  signal?.throwIfAborted()
  return prepared.finish(result)
}
