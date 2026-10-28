import type { RuleEvent, V2Action, NormalizedRuleV2 } from './block-rules.js'
import { variableKey, variableSnapshot, type RuleEntry, type RuleDocument, type RuleVariable } from './declarations.js'
import type { EngineRuntime } from './runtime-types.js'
import type { PlanningDecision } from './planning-types.js'
import { readActionState } from './entry-lifecycle.js'

export interface VariableTransitionPorts {
  read(): { variables: Record<string, unknown>; scopes?: Record<string, Record<string, unknown>> }
  documents(): readonly RuleDocument[]
  token(variables: Record<string, unknown>): string
  save(declaration: RuleVariable, value: unknown, turnId: string, assertCurrent: () => void): Promise<unknown>
  assertCurrent(token?: string): void
}
/** Renew only the token predicted for this acknowledged variable write. */
export async function writeActionVariable(variable: string | undefined, value: unknown, turnId: string, ports: VariableTransitionPorts) {
  const declaration = ports.documents().flatMap(document => document.variables).find(item => item.name === variable)
  if (!declaration) throw new Error('variable-unavailable')
  const variables = { ...ports.read().variables, [variableKey(declaration, turnId)]: structuredClone(value) }
  const expected = ports.token(variables)
  await ports.save(declaration, value, turnId, () => ports.assertCurrent())
  // An unrelated source, preference or variable change must not be absorbed.
  ports.assertCurrent(expected)
  return { token: expected, vars: variableSnapshot({ ...ports.read(), documents: ports.documents() }, turnId) }
}

export interface ActionIdentity { sourceId: string; ruleId: string; ruleRevision: number }
export const actionKey = (event: ActionIdentity, action: Pick<V2Action, 'id'>) => JSON.stringify([event.sourceId, event.ruleId, event.ruleRevision, action.id])
export const dispatchKey = (event: ActionIdentity, action: Pick<V2Action, 'id'>) => `$dispatch:${actionKey(event, action)}`
export const requestViews = (rules: readonly NormalizedRuleV2[]) => new Set(rules.flatMap(rule => [rule.select.view, ...rule.actions.flatMap(action => action.target ? [action.target.view] : [])]))
export const entryDirectory = (documents: readonly RuleDocument[]) => new Map(documents.flatMap(document => document.entries.map(entry =>
  [JSON.stringify([`context-care:document:${document.id}`, `entry:${entry.id}`]), entry] satisfies [string, RuleEntry])))
export interface RuntimePolicyInput {
  closed: boolean
  storageAvailable: boolean
  current(): boolean
  select(): PlanningDecision
  runtime(): EngineRuntime
  event: RuleEvent
  action: V2Action
  turnId: string
  entry(): RuleEntry | undefined
  dispatchId?: string
  delivery?: boolean
  sinceSeq?: number
  now?: number
}
/** 先策略再副作用；普通成功状态、运行预约和真实交接预约一起参与裁决。 */
export function decideRuntimeAction({ closed, storageAvailable, current, select, runtime, event, action, turnId, entry, dispatchId, delivery = false, sinceSeq = -1, now = Date.now() }: RuntimePolicyInput): PlanningDecision {
  if (closed || !storageAvailable) return { enabled: false, reason: 'workbench-storage-unavailable' }
  if (!current()) return { enabled: false, reason: 'workbench-changed' }
  const selected = select()
  if (!selected.enabled) return selected
  const evidence = event.triggerSeq === undefined ? event.sourceSeqs : [event.triggerSeq]
  if (evidence.some(seq => seq <= sinceSeq)) return { enabled: false, reason: 'historical-evidence' }
  if (!delivery) {
    const state = runtime(), key = actionKey(event, action), held = readActionState(state.state[dispatchKey(event, action)])
    if (held && held.status !== 'settled' && !(held.status === 'handoff' && held.callId === dispatchId))
      return { enabled: false, reason: held.status === 'unknown' && typeof held.reason === 'string' ? held.reason : 'request-dispatch-reserved' }
    const previous = readActionState(state.state[key])
    if (action.dedupe.mode === 'occurrence' && previous?.occurrenceId === event.occurrenceId) return { enabled: false, reason: 'duplicate-occurrence' }
    if (!entry() || action.stage !== 'request.assemble') {
      if (previous?.lastStarted !== undefined && now - previous.lastStarted < action.cooldownMs) return { enabled: false, reason: 'cooldown' }
      const lifetime = action.target?.lifetime ?? 'request'
      if (previous && (lifetime === 'session' || lifetime === 'turn' && previous.turnId === turnId)) return { enabled: false, reason: 'action-lifetime-consumed' }
    }
  }
  return selected
}
