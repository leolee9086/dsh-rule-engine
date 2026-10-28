import type { NormalizedRuleV2, RuleEvent, V2Action } from './block-rules.js'
import type { RuleDocument, RuleEntry } from './declarations.js'
import { entryPolicy, readActionState } from './entry-lifecycle.js'
import { actionKey, requestViews } from './runtime-policy.js'
import { indexFirstRules } from './request-rule-index.js'
import type { EngineRuntime } from './runtime-types.js'
import type { PlanningRequest, PlanningBlock, PlanningSnapshot, PlanningDecision } from './planning-types.js'
import { planRequest } from './request-plan.js'
import type { DetectionInput, DetectionOptions } from './detector-registry.js'

export type EntryPolicies = Record<string, ReturnType<typeof entryPolicy>>
export interface EntryTransition { event: RuleEvent; action: V2Action; key: string }
export interface StageSnapshot extends PlanningSnapshot { session: { id: string; turnId: string } }
export type RequestPlanResult<R extends PlanningRequest> = ReturnType<typeof planRequest<R, PlanningBlock>>
export interface StagePlanInput<R extends PlanningRequest, B extends PlanningBlock> {
  request: R
  rules: readonly NormalizedRuleV2[]
  documents: readonly RuleDocument[]
  blocks: readonly B[]
  stage: string
  snapshot: StageSnapshot
  token: string
  freshSeq?: number
  admissions?: ReadonlyMap<NormalizedRuleV2, number>
  turn?: number
  signal?: AbortSignal
  detectorScope?: string
  maxCascadePasses?: number
  maxInjectedChars?: number
  maxInjectedTokens?: number
  maxCacheChangedBytes?: number
  detect(input: DetectionInput, signal?: AbortSignal, options?: DetectionOptions): Promise<RuleEvent[]>
  enabled(rules: readonly NormalizedRuleV2[]): NormalizedRuleV2[]
  runtime(): EngineRuntime
  current(): boolean
  unseen?(events: RuleEvent[]): RuleEvent[]
  project(request: R, views: ReadonlySet<string>): readonly B[]
  plan(input: { request: R; blocks: readonly B[]; rules: readonly NormalizedRuleV2[]; events: readonly RuleEvent[]; snapshot: StageSnapshot;
    policies: EntryPolicies; maxInjectedChars?: number; maxInjectedTokens?: number; impactBaseline?: R }): RequestPlanResult<R> | Promise<RequestPlanResult<R>>
  withDecisions<T>(run: (decision: (event: RuleEvent, action: V2Action) => PlanningDecision) => T): T
}
/** 匹配、条目物化、级联与总预算组成同一次阶段规划。原生块投影由接入端口提供。 */
export async function planStage<R extends PlanningRequest, B extends PlanningBlock>({ request, rules, documents, blocks, stage, snapshot, token, freshSeq, admissions, turn,
  signal, detectorScope, maxCascadePasses = 4, maxInjectedChars = 65536, maxInjectedTokens, maxCacheChangedBytes, detect, enabled: isEnabled, runtime,
  current, unseen, project, plan, withDecisions }: StagePlanInput<R, B>) {
  const admittedRules = admissions && freshSeq !== undefined ? rules.filter(rule => freshSeq > (admissions.get(rule) ?? -1)) : rules
  let enabled = isEnabled(admittedRules)
  const entries = new Map<string, RuleEntry>(documents.flatMap(document => document.entries.filter(entry => entry.target.view === 'model').map(entry =>
    [JSON.stringify([`context-care:document:${document.id}`, `entry:${entry.id}`, entry.revision, 'inject']), entry])))
  const policies: EntryPolicies = {}, entryPrevious: Record<string, unknown> = {}, entryTransitions: EntryTransition[] = []
  if (stage === 'request.assemble') {
    if (turn === undefined) throw new Error('entry-turn-unavailable')
    const strict = enabled.filter(rule => entries.has(actionKey({ sourceId: rule.sourceId, ruleId: rule.id, ruleRevision: rule.revision }, rule.actions[0])))
      .map(({ exclusiveGroup: _exclusive, ...rule }) => rule)
    const matched = await detect({ rules: strict, blocks, stage, snapshot }, signal, { sessionId: snapshot.session.id, current })
    const matches = new Set(matched.map(event => JSON.stringify([event.sourceId, event.ruleId])))
    snapshot.materializations = {}
    const state = runtime()
    enabled = enabled.map(rule => {
      const action = rule.actions[0], identity = { sourceId: rule.sourceId, ruleId: rule.id, ruleRevision: rule.revision }, key = actionKey(identity, action), entry = entries.get(key)
      if (!entry) return rule
      // CAS 对比必须保留已确认 JSON 的原始字段顺序；结构校验不能重排事实快照。
      const previousValue = state.state[key]
      entryPrevious[key] = structuredClone(previousValue ?? null)
      const previous = readActionState(previousValue)
      const policy = policies[key] = entryPolicy(entry, previous, { turnId: snapshot.session.turnId, turn, matches: matches.has(JSON.stringify([rule.sourceId, rule.id])) })
      if (policy.reuse && policy.text !== undefined) (snapshot.materializations ??= {})[key] = policy.text
      if (policy.inactive) entryTransitions.push({ event: { schemaVersion: 2, ...identity, occurrenceId: `entry-inactive:${key}:${snapshot.session.turnId}`, sourceSeqs: [],
        stage, view: 'model', blockId: '', coordinate: 'utf16', ranges: [], captures: {}, facts: {}, block: { id: '', view: 'model', role: 'user', type: 'text', seq: 0 } }, action, key })
      const { exclusiveGroup: _exclusive, ...ungrouped } = rule, candidate = policy.reason ? ungrouped : rule
      return policy.reuse ? { ...candidate, match: { kind: 'always' } } : candidate
    })
  }
  const detected = await detect({ rules: enabled, blocks, stage, snapshot, freshSeq }, signal, { sessionId: snapshot.session.id, scope: detectorScope, epoch: token, current })
  const events = unseen ? unseen(detected) : detected
  const planned = await plan({ request, blocks, rules, events, snapshot, policies, maxInjectedChars, maxInjectedTokens })
  if (stage === 'request.assemble') {
    const visited = new Set(events.map(event => JSON.stringify([event.sourceId, event.ruleId])))
    const cascading = new Set(documents.flatMap(document => document.entries.filter(entry => entry.cascade).map(entry => JSON.stringify([`context-care:document:${document.id}`, `entry:${entry.id}`]))))
    for (let pass = 1; cascading.size && pass <= maxCascadePasses + 1; pass++) {
      const remaining = enabled.filter(rule => cascading.has(JSON.stringify([rule.sourceId, rule.id])) && !visited.has(JSON.stringify([rule.sourceId, rule.id])))
      if (!remaining.length) break
      const nextBlocks = project(planned.request, requestViews(remaining))
      const found = await detect({ rules: remaining, blocks: nextBlocks, stage, snapshot }, signal, { sessionId: snapshot.session.id, current })
      if (!found.length) break
      if (pass > maxCascadePasses) { planned.records.push(...found.map(event => ({ sourceId: event.sourceId, ruleId: event.ruleId, actionId: '', status: 'skipped', reason: 'cascade-pass-limit' }))); break }
      const remainingByIdentity = indexFirstRules(remaining)
      for (const event of found) {
        const identity = JSON.stringify([event.sourceId, event.ruleId]); visited.add(identity)
        const rule = remainingByIdentity.get(identity)
        if (!rule) throw new Error('request-plan-rule-unavailable')
        for (const action of rule.actions) {
          const key = actionKey(event, action), entry = entries.get(key)
          if (!entry) continue
          if (turn === undefined) throw new Error('entry-turn-unavailable')
          const policy = policies[key] = entryPolicy(entry, entryPrevious[key] ?? undefined, { turnId: snapshot.session.turnId, turn, matches: true })
          if (policy.reuse && policy.text !== undefined) (snapshot.materializations ??= {})[key] = policy.text
        }
      }
      const next = await plan({ request: planned.request, blocks: nextBlocks, rules, events: found, snapshot, policies,
        maxInjectedChars: maxInjectedChars - planned.injectedChars, maxInjectedTokens: maxInjectedTokens === undefined || planned.injectionBudget.tokens === null ? undefined : maxInjectedTokens - planned.injectionBudget.tokens, impactBaseline: request })
      planned.request = next.request; planned.diff.after = next.diff.after; planned.impact = next.impact; planned.injectedChars += next.injectedChars
      planned.injectionBudget.tokens = planned.injectionBudget.tokens === null || next.injectionBudget.tokens === null ? null : planned.injectionBudget.tokens + next.injectionBudget.tokens
      planned.records.push(...next.records.map(record => ({ ...record, cascadePass: pass }))); planned.applied.push(...next.applied); planned.scheduled.push(...next.scheduled)
    }
  }
  if (maxCacheChangedBytes !== undefined && planned.impact.changedSuffixBytes > maxCacheChangedBytes) throw new Error('request-cache-change-budget-exceeded')
  if (!current()) throw new Error('workbench-changed-during-planning')
  const appliedKeys = entryTransitions.length ? new Set(planned.applied.map(item => item.key)) : undefined
  const transitions = entryTransitions.length ? withDecisions(decision => entryTransitions.filter(item => policies[item.key].inactive
    && !appliedKeys?.has(item.key) && decision(item.event, item.action).enabled)) : []
  planned.records.push(...transitions.map(item => ({ sourceId: item.event.sourceId, ruleId: item.event.ruleId, actionId: item.action.id, status: 'planned', reason: 'entry-deactivation' })))
  return { ...planned, entryPolicies: policies, entryPrevious, entryTransitions: transitions, turn,
    token, stage, turnId: snapshot.session.turnId, documents: documents.map(document => ({ id: document.id, revision: document.revision })) }
}
