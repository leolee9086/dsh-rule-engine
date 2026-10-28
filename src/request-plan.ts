import { createTextTransformPlan, executeTextTransforms, type TextTransformExecutor } from './text-transform-plan.js'
import { bindInputs, type V2Action, type RuleEvent } from './block-rules.js'
import { indexRequestActions, type RequestActionStages } from './request-action-order.js'
import { indexRequestBlocks, filteredAncestor, orderRequestRemovals } from './request-block-index.js'
import { createBlockPatchPlan } from './display-patch-plan.js'
import { settlePlannedDependencies } from './planned-dependencies.js'
import type { BlockPatch } from './patch-types.js'
import { createArgumentPatchState, mergeRequestInsertions } from './request-plan-mutations.js'
import type { PlanningRequest, PlanningBlock, RequestPlanInput, PlanningRecord, PlannedAction, ScheduledAction, RequestInsertion } from './planning-types.js'

const evidenceActionKey = (event: RuleEvent, action: V2Action) => JSON.stringify([event.sourceId, event.ruleId, event.occurrenceId, action.id])
const deferredKinds = new Set(['program', 'tool', 'job', 'set-variable', 'notify', 'abort', 'resume', 'compact'])

/** 缓存裁决只有一份：同步与 Worker 执行仅决定如何求值文本程序。 */
function requestBudget<R extends PlanningRequest, B extends PlanningBlock>(input: RequestPlanInput<R, B>) {
  const excluded = new Set<string>()
  const rank = new Map(input.rules.map(rule => [JSON.stringify([rule.sourceId, rule.id]), rule.priority]))
  const prepare = (decision: RequestPlanInput<R, B>['decision']) => preparePass({ ...input, decision(event, action) {
    return excluded.has(evidenceActionKey(event, action)) ? { enabled: false, reason: 'request-cache-change-budget-exceeded' } : decision(event, action)
  } })
  return {
    prepare: () => input.withDecisions ? input.withDecisions(prepare) : prepare(input.decision),
    accept(planned: ReturnType<ReturnType<typeof preparePass<R, B>>['finish']>) {
      if (input.maxCacheChangedBytes === undefined || planned.impact.changedSuffixBytes <= input.maxCacheChangedBytes) return true
      const candidates = planned.applied.filter(item => ['inject', 'guidance', 'replace', 'transform', 'filter'].includes(item.action.kind))
      candidates.sort((a, b) => (rank.get(JSON.stringify([b.event.sourceId, b.event.ruleId])) ?? 0) - (rank.get(JSON.stringify([a.event.sourceId, a.event.ruleId])) ?? 0))
      const last = candidates.at(-1)
      if (!last) throw new Error('request-cache-change-budget-exceeded')
      excluded.add(evidenceActionKey(last.event, last.action))
      return false
    },
  }
}
export function planRequest<R extends PlanningRequest, B extends PlanningBlock>(input: RequestPlanInput<R, B>) {
  const budget = requestBudget(input)
  for (;;) {
    const prepared = budget.prepare(), planned = prepared.finish(executeTextTransforms(prepared.tasks))
    if (budget.accept(planned)) return planned
  }
}
/** 异步宿主复用完整提案与裁决，只把文本程序交给可终止执行器。 */
export async function planRequestAsync<R extends PlanningRequest, B extends PlanningBlock>(input: RequestPlanInput<R, B>, execute: TextTransformExecutor, signal?: AbortSignal) {
  const budget = requestBudget(input)
  for (;;) {
    signal?.throwIfAborted()
    const prepared = budget.prepare()
    const result = prepared.tasks.length ? await execute({ textTransforms: prepared.tasks }, signal) : []
    signal?.throwIfAborted()
    const planned = prepared.finish(result)
    if (budget.accept(planned)) return planned
  }
}

function preparePass<R extends PlanningRequest, B extends PlanningBlock>({ request, blocks, rules, events, templates, snapshot, decision, ports,
  maxInjectedChars = 65536, maxRequestBytes = 8388608, maxInjectedTokens, impactBaseline = request, analysis }: RequestPlanInput<R, B>) {
  let next = request
  // 首次实际写入才复制 JSON 消息；AbortSignal 和 prepared-call 等原生句柄保持身份。
  const writable = () => {
    if (next === request) {
      next = { ...request, messages: structuredClone(request.messages) }
      analysis?.cloned(request.messages, next.messages)
    }
    return next
  }
  const writeBlock = (block: B, value: unknown) => {
    const owned = writable()
    if (block.messageIndex >= 0) analysis?.changed(owned.messages[block.messageIndex])
    ports.writeBlock(owned, block, value === undefined ? undefined : structuredClone(value))
  }
  const indexed = analysis ? analysis.blockIndex(blocks) : indexRequestBlocks(blocks)
  const writableBlocks = indexed.model, writableById = indexed.byId
  let patchPlan: ReturnType<typeof createBlockPatchPlan<B, BlockPatch>> | undefined
  const filters = new Set<string>(), filteredCalls = new Set<string>(), insertions: RequestInsertion[] = []
  const records: PlanningRecord[] = [], applied: PlannedAction[] = [], scheduled: ScheduledAction[] = []
  const transforms = createTextTransformPlan()
  const injectedEntries = new Set<string>(), argumentPatches = new Map<string, ReturnType<typeof createArgumentPatchState>>()
  const byRule = new Map(rules.map(rule => [JSON.stringify([rule.sourceId, rule.id]), rule]))
  const localActions = new Map<readonly V2Action[], RequestActionStages<V2Action>>()
  const stateKey = (event: RuleEvent, action: V2Action) => JSON.stringify([event.sourceId, event.ruleId, event.ruleRevision, action.id])
  let injectedChars = 0, injectedTokens: number | null = ports.estimateMessage ? 0 : null
  const prioritized = [...events].sort((a, b) => (byRule.get(JSON.stringify([b.sourceId, b.ruleId]))?.priority ?? 0) - (byRule.get(JSON.stringify([a.sourceId, a.ruleId]))?.priority ?? 0))
  for (const event of prioritized) {
    const rule = byRule.get(JSON.stringify([event.sourceId, event.ruleId]))
    if (!rule) throw new Error('request-plan-rule-unavailable')
    let stages = analysis ? analysis.actionIndex(rule.actions) : localActions.get(rule.actions)
    if (!stages) { stages = indexRequestActions(rule.actions); localActions.set(rule.actions, stages) }
    const schedule = stages.get(event.stage), outcomes = new Map<string, boolean>()
    for (const action of schedule?.order ?? []) {
      const eligible = decision(event, action)
      const record: PlanningRecord = { sourceId: event.sourceId, ruleId: event.ruleId, actionId: action.id, occurrenceId: event.occurrenceId,
        blockId: event.blockId, ranges: event.ranges, captures: event.captures, status: 'planned' }
      records.push(record)
      if (!eligible.enabled) { record.status = 'skipped'; record.reason = eligible.reason; outcomes.set(action.id, false); continue }
      if (action.dependsOn.some(id => outcomes.get(id) === false)) { record.status = 'skipped'; record.reason = 'dependency-not-planned'; outcomes.set(action.id, false); continue }
      const key = stateKey(event, action)
      if (event.ruleId.startsWith('entry:') && injectedEntries.has(key)) { record.status = 'skipped'; record.reason = 'entry-already-selected'; continue }
      const context = { ...snapshot, surface: event.block.surface, captures: event.captures, facts: event.facts, block: event.block,
        tool: { name: event.block.raw?.name, arguments: event.block.arguments, result: event.block.raw?.content }, results: snapshot.results ?? {} }
      const deferred = action.dependsOn.length > 0 && (event.stage !== 'request.assemble' || deferredKinds.has(action.kind))
      // 激活条目保存已渲染的字面文本，复用时保持其内容原样。
      const text = action.template === undefined || deferred ? undefined
        : Object.hasOwn(snapshot.materializations ?? {}, key) ? snapshot.materializations?.[key] : templates.render(action.template, context)
      if (text !== undefined && text.length > (action.maxChars ?? maxInjectedChars)) throw new Error('action-output-budget-exceeded')
      const block = writableById.get(event.blockId)
      if (action.kind === 'replace' && event.block.text !== undefined && block?.text !== event.block.text) throw new Error('replacement-projection-range-unavailable')
      if (action.kind === 'replace') {
        if (!block) throw new Error('replacement-cross-block-requires-explicit-patches')
        if (action.patch?.kind === 'tool-arguments') {
          if (block.type !== 'tool-call' || block.argumentsError) throw new Error('tool-argument-patch-needs-valid-json-call')
          if (block.source?.replayState !== undefined) throw new Error('replacement-opaque-provider-state-denied')
          let changes = argumentPatches.get(block.id)
          if (!changes) { changes = createArgumentPatchState(block.arguments); argumentPatches.set(block.id, changes) }
          if (changes.conflicts(action.patch.path)) { record.status = 'skipped'; record.reason = 'overlapping-argument-patch'; outcomes.set(action.id, false); continue }
          const result = changes.apply(action.patch.path, bindInputs(action.patch.value, context))
          writeBlock(block, { ...block.raw, arguments: result.after })
          record.before = result.before; record.after = result.after
        } else {
          if ((event.field ?? 'block.text') !== 'block.text') throw new Error('replacement-evidence-is-not-block-text')
          const ranges = event.ranges.length ? event.ranges : [[0, block.text?.length ?? 0]]
          if (typeof text !== 'string') throw new TypeError('rules-v2: replacement must be text')
          const candidates = ranges.map(range => ({ blockId: block.id, actionId: `${event.occurrenceId}:${action.id}`, priority: rule.priority, range, text }))
          patchPlan ??= createBlockPatchPlan(writableBlocks, undefined, id => indexed.same(id))
          if (!patchPlan.accept(candidates)) { record.status = 'skipped'; record.reason = 'overlapping-patch'; outcomes.set(action.id, false); continue }
        }
      } else if (action.kind === 'transform') {
        if (!block || event.segments) throw new Error('text-transform-cross-block-write-unavailable')
        transforms.add(block, action, context, record)
      } else if (action.kind === 'filter') {
        if (!block) throw new Error('filter-cross-block-requires-explicit-targets')
        if (block.signed || block.source?.replayState !== undefined) throw new Error('filter-opaque-provider-state-denied')
        if (block.callId) {
          if (!filteredCalls.has(block.callId)) {
            const group = indexed.byCall.get(block.callId) ?? []
            if (group.some(candidate => candidate.signed || candidate.source?.replayState !== undefined)) throw new Error('filter-opaque-provider-state-denied')
            for (const candidate of group) filters.add(candidate.id)
            filteredCalls.add(block.callId)
          }
          record.reason = 'tool-call-result-group'
        } else filters.add(block.id)
      } else if (['inject', 'guidance'].includes(action.kind) && event.stage === 'request.assemble') {
        const target = action.target ?? { view: 'model', role: 'user', anchor: 'end', position: 'after' }
        if (target.view !== 'model') throw new Error('request-injection-view-mismatch')
        if (target.role === 'tool') throw new Error('tool-role-injection-requires-real-result')
        if (target.role === 'system' && !['start', 'end'].includes(target.anchor ?? '')) throw new Error('system-injection-anchor-unavailable')
        let at: number
        if (target.anchor === 'end') at = next.messages.length
        else if (target.anchor === 'start') at = 0
        else if (target.anchor === 'depth') {
          if (target.depth === undefined || !Number.isSafeInteger(target.depth) || target.depth > next.messages.length) {
            record.status = 'skipped'; record.reason = 'injection-depth-anchor-unavailable'; outcomes.set(action.id, false); continue
          }
          at = next.messages.length - target.depth
        } else {
          const anchor = target.anchor === 'matched' ? block : indexed.firstModel(target.anchor ?? '')
          if (!anchor || anchor.messageIndex < 0) { record.status = 'skipped'; record.reason = 'injection-anchor-unavailable'; outcomes.set(action.id, false); continue }
          at = anchor.messageIndex + (target.position === 'before' ? 0 : 1)
        }
        if (typeof text !== 'string') throw new Error('injection-text-unavailable')
        if (injectedChars + text.length > maxInjectedChars) throw new Error('total-injection-budget-exceeded')
        const measured = ports.estimateMessage?.({ role: target.role ?? 'user', content: [{ type: 'text', text }] })
        if (measured !== undefined && (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0)) throw new Error('injection-token-estimate-invalid')
        const tokens = measured === undefined ? null : Math.ceil(measured)
        if (maxInjectedTokens !== undefined && (tokens === null || injectedTokens === null || injectedTokens + tokens > maxInjectedTokens)) {
          record.status = 'skipped'; record.reason = tokens === null ? 'injection-token-estimate-unavailable' : 'injection-token-budget-exceeded'
          record.estimatedTokens = tokens; outcomes.set(action.id, false); continue
        }
        injectedChars += text.length
        if (tokens !== null && injectedTokens !== null) injectedTokens += tokens
        insertions.push({ at, origin: block?.messageIndex ?? event.block.seq, priority: rule.priority, key, role: target.role ?? 'user', text, event, action })
        if (event.ruleId.startsWith('entry:')) injectedEntries.add(key)
      } else if (deferredKinds.has(action.kind) || action.kind === 'inject' || action.kind === 'guidance') {
        scheduled.push({ event, action, context, inputs: action.inputs === undefined || deferred ? undefined : bindInputs(action.inputs, context),
          inputsDeferred: deferred, templateDeferred: deferred && action.template !== undefined, text })
      } else throw new Error(`request-action-unavailable:${action.kind}`)
      outcomes.set(action.id, true)
      applied.push({ event, action, key, ...(text === undefined ? {} : { text }) })
    }
    if (schedule?.cycle) throw new Error('request-plan-dependency-cycle')
  }
  const patched = patchPlan ? patchPlan.finish() : { blocks: writableBlocks, results: [] }
  const textPlan = transforms.prepare(patched.blocks)
  return { tasks: textPlan.tasks, finish: (result: unknown) => {
  for (const block of textPlan.finish(result)) if (block !== writableById.get(block.id) && !filters.has(block.id)) writeBlock(block, block.raw)
  const removedPaths = new Set<string>()
  if (filters.size) for (const block of blocks) if (filters.has(block.id) && block.path !== '$result') removedPaths.add(JSON.stringify([block.messageIndex, block.path]))
  for (const block of orderRequestRemovals(writableBlocks, filters)) {
    if (block.path === '$result') { const owned = writable(); analysis?.changed(owned.messages[block.messageIndex]); owned.messages[block.messageIndex].content = []; continue }
    if (filteredAncestor(block, removedPaths)) continue
    if (next.messages[block.messageIndex]?.content.length || block.messageIndex === -1) writeBlock(block, undefined)
  }
  if (insertions.length) {
    const owned = writable(), merged = mergeRequestInsertions(owned.messages, owned.system, insertions, insertion => ports.insertionMessage(insertion))
    owned.messages = merged.messages
    if (merged.hasSystem) owned.system = merged.system
  }
  if (next !== request || (analysis ? analysis.read(request).hasEmptyMessages : request.messages.some(message => !message.content.length))) {
    writable().messages = next.messages.filter(message => message.content.length > 0)
    const beforePairs = analysis ? analysis.pairIndex(request) : ports.pairs(request), afterPairs = analysis ? analysis.pairIndex(next) : ports.pairs(next)
    for (const id of beforePairs.calls) if (beforePairs.results.has(id) && afterPairs.calls.has(id) !== afterPairs.results.has(id)) throw new Error('tool-call-result-pair-broken')
  }
  const impact = analysis ? analysis.impact(impactBaseline, next) : ports.impact(impactBaseline, next)
  if (impact.afterBytes > maxRequestBytes) throw new Error('request-byte-budget-exceeded')
  const admitted = settlePlannedDependencies(records, applied, scheduled)
  return { request: next, records: [...records, ...patched.results], ...admitted, injectedChars,
    injectionBudget: { kind: injectedTokens === null ? 'unknown' : 'estimate', tokens: injectedTokens, limit: maxInjectedTokens ?? null }, impact,
    diff: { before: { system: request.system, messages: request.messages }, after: { system: next.system, messages: next.messages } } }
  } }
}
