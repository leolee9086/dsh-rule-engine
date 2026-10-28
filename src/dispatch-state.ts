import type { RuleDocument } from './declarations.js'
import type { EngineRuntime } from './runtime-types.js'
import type { PlannedAction, ScheduledAction } from './planning-types.js'
import type { EntryTransition, EntryPolicies } from './stage-plan.js'
import { actionKey, dispatchKey, entryDirectory } from './runtime-policy.js'
import { deliveredEntry, deactivatedEntry } from './entry-lifecycle.js'
import { isRecord } from './guard.js'

export interface DispatchPlan {
  applied: readonly PlannedAction[]
  scheduled: readonly ScheduledAction[]
  entryTransitions?: readonly EntryTransition[]
  entryPrevious?: Record<string, unknown>
  entryPolicies?: EntryPolicies
  turnId: string
  turn?: number
}
export const dispatchItems = (planned: Pick<DispatchPlan, 'applied' | 'entryTransitions'>) => [...new Map([...planned.applied, ...(planned.entryTransitions ?? [])].map(item => [dispatchKey(item.event, item.action), item])).values()]
export function recoverDispatches(runtime: EngineRuntime, now = Date.now()): boolean {
  let changed = false
  for (const [key, value] of Object.entries(runtime.state)) if (key.startsWith('$dispatch:') && isRecord(value) && ['reserved', 'handoff'].includes(String(value.status))) {
    Object.assign(value, { status: 'unknown', reason: 'request-handoff-unconfirmed-after-restart', updatedAt: now }); changed = true
  }
  return changed
}
export function reserveDispatch(runtime: EngineRuntime, planned: DispatchPlan, callId: string, now = Date.now()): void {
  for (const { event, action } of dispatchItems(planned)) {
    const entryKey = actionKey(event, action)
    if (Object.hasOwn(planned.entryPrevious ?? {}, entryKey) && JSON.stringify(runtime.state[entryKey] ?? null) !== JSON.stringify(planned.entryPrevious?.[entryKey])) throw new Error('entry-state-changed-before-dispatch')
    const key = dispatchKey(event, action), held = runtime.state[key]
    if (isRecord(held) && held.status !== 'settled' && !(held.status === 'reserved' && held.callId === callId)) throw new Error('request-dispatch-reserved')
    runtime.state[key] = { status: 'reserved', callId, occurrenceId: event.occurrenceId, updatedAt: now }
  }
}
export function hasDispatch(runtime: EngineRuntime, callId: string, statuses: readonly string[]): boolean {
  return Object.entries(runtime.state).some(([key, value]) => key.startsWith('$dispatch:') && isRecord(value) && value.callId === callId && statuses.includes(String(value.status)))
}
export function rollbackDispatch(runtime: EngineRuntime, callId: string): void {
  for (const [key, held] of Object.entries(runtime.state)) if (key.startsWith('$dispatch:') && isRecord(held) && held.callId === callId && held.status === 'reserved') delete runtime.state[key]
}
export function unknownDispatch(runtime: EngineRuntime, callId: string, now = Date.now()): void {
  for (const [key, held] of Object.entries(runtime.state)) if (key.startsWith('$dispatch:') && isRecord(held) && held.callId === callId && ['reserved', 'handoff'].includes(String(held.status)))
    Object.assign(held, { status: 'unknown', reason: 'request-handoff-ack-unconfirmed', updatedAt: now })
}
/** 原生请求已交接后的事实；scheduled 成员按事件与动作对象身份匹配。 */
export function handoffDispatch(runtime: EngineRuntime, planned: DispatchPlan, callId: string, documents: () => readonly RuleDocument[], now = Date.now()): void {
  for (const { event, action } of dispatchItems(planned)) {
    const held = runtime.state[dispatchKey(event, action)]
    if (!isRecord(held) || held.callId !== callId || held.status !== 'reserved') throw new Error('request-reservation-unavailable')
    Object.assign(held, { status: 'handoff', updatedAt: now })
  }
  for (const { key } of planned.entryTransitions ?? []) runtime.state[key] = deactivatedEntry(runtime.state[key], now)
  const scheduled = new Map<ScheduledAction['event'], Set<ScheduledAction['action']>>()
  for (const job of planned.scheduled) {
    let actions = scheduled.get(job.event)
    if (!actions) { actions = new Set(); scheduled.set(job.event, actions) }
    actions.add(job.action)
  }
  const immediate = planned.applied.filter(item => !scheduled.get(item.event)?.has(item.action)), entries = immediate.length ? entryDirectory(documents()) : undefined
  for (const { event, action, text } of immediate) {
    const key = actionKey(event, action), entry = entries?.get(JSON.stringify([event.sourceId, event.ruleId])), policy = planned.entryPolicies?.[key]
    if (entry && policy) {
      if (planned.turn === undefined || text === undefined) throw new Error('entry-materialization-unavailable')
      runtime.state[key] = { ...deliveredEntry(entry, runtime.state[key], policy, text, { turnId: planned.turnId, turn: planned.turn, now }), occurrenceId: event.occurrenceId }
    } else runtime.state[key] = { lastStarted: now, occurrenceId: event.occurrenceId, turnId: planned.turnId }
  }
}
export function settleDispatch(runtime: EngineRuntime, planned: DispatchPlan, callId: string, now = Date.now()): void {
  for (const { event, action } of dispatchItems(planned)) {
    const held = runtime.state[dispatchKey(event, action)]
    if (!isRecord(held) || held.callId !== callId || held.status !== 'handoff') throw new Error('request-handoff-reservation-unavailable')
    Object.assign(held, { status: 'settled', updatedAt: now })
  }
}
