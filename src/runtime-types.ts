import type { RuleEvent, V2Action } from './block-rules.js'
import type { PlanningSnapshot } from './planning-types.js'

export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue }
/** 持久运行记录同时承载动作、匹配诊断和原生派发的确认事实。 */
export interface ActionRunRecord {
  id: string
  status: string
  kind?: string
  key?: string
  sourceId?: string
  ruleId?: string
  ruleRevision?: number
  actionId?: string
  occurrenceId?: string
  dispatchId?: string
  blockId?: string
  sourceSeqs?: number[]
  triggerSeq?: number
  inputs?: unknown
  result?: { value?: unknown; [key: string]: unknown }
  reason?: string | null
  delivery?: string
  createdAt?: number
  updatedAt?: number
  startedAt?: number
  finishedAt?: number
  cancellationRequested?: boolean
  controlToken?: string
  [key: string]: unknown
}
export interface Materialization { text: string; turnId: string; turn: number; stickyUntilTurn: number | null }
export interface ActionState {
  lastStarted?: number
  occurrenceId?: string
  turnId?: string
  lastActivationAt?: number
  lastInactiveAt?: number
  materialization?: Materialization
  [key: string]: unknown
}
export interface EngineRuntime { runs: unknown[]; state: Record<string, unknown> }
export interface ActionWorkItem {
  event: RuleEvent
  action: V2Action
  context: PlanningSnapshot & { session: { turnId: string; [key: string]: unknown } }
  inputs?: unknown
  inputsDeferred?: boolean
  templateDeferred?: boolean
  text?: string
  token?: string
  dispatchId?: string
}
