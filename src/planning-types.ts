import type { V2Block, V2Action, RuleEvent, NormalizedRuleV2 } from './block-rules.js'
import type { PatchResult } from './patch-types.js'
import type { indexRequestBlocks } from './request-block-index.js'
import type { RequestActionStages } from './request-action-order.js'

/** 引擎只处理可独立复制的消息正文；运行句柄继续由调用方持有。 */
export interface PlanningMessage {
  id?: string
  role?: string
  toolCallId?: unknown
  content: unknown[]
  source?: unknown
}
export interface PlanningRequest {
  messages: PlanningMessage[]
  system?: string
}
export interface DisplayBlock extends V2Block {
  path: string
  replayState?: unknown
}
export interface PlanningBlock extends DisplayBlock {
  messageIndex: number
  callId?: string
  argumentsError?: unknown
  replayState?: unknown
  source?: { replayState?: unknown }
  raw?: { name?: string; content?: string; text?: string; [key: string]: unknown }
}
export interface PlanningDecision { enabled: boolean; reason?: string }
export interface PlanningTemplates { render(template: string, context: Record<string, unknown>): string }
export interface PlanningSnapshot extends Record<string, unknown> {
  results?: Record<string, unknown>
  materializations?: Record<string, string>
}
export interface RequestImpact {
  basis: string
  providerSerialization: string
  cacheHitTokens: number | null
  beforeBytes: number
  afterBytes: number
  commonPrefixBytes: number
  firstChangedByte: number | null
  changedSuffixBytes: number
}
export interface RequestPairs { readonly calls: ReadonlySet<unknown>; readonly results: ReadonlySet<unknown> }
export interface PlannedAction {
  event: RuleEvent
  action: V2Action
  key: string
  text?: string
}
export interface ScheduledAction {
  event: RuleEvent
  action: V2Action
  context: PlanningSnapshot
  inputs?: unknown
  inputsDeferred: boolean
  templateDeferred: boolean
  text?: string
}
export interface PlanningRecord extends PatchResult {
  sourceId?: string
  ruleId?: string
  occurrenceId?: string
  ranges?: number[][]
  captures?: Record<string, unknown>
  estimatedTokens?: number | null
}
export interface RequestInsertion {
  at: number
  origin?: number
  priority: number
  key: string
  role: string
  text: string
  event: RuleEvent
  action: V2Action
}
/** 宿主负责实际格式写入、消息来源标识和计量，引擎决定写入目标和预算准入。 */
export interface RequestPlanningPorts<R extends PlanningRequest, B extends PlanningBlock> {
  writeBlock(request: NoInfer<R>, block: NoInfer<B>, value: unknown): void
  insertionMessage(insertion: RequestInsertion): R['messages'][number]
  impact(before: R, after: R): RequestImpact
  pairs(request: R): RequestPairs
  estimateMessage?: (message: { role: string; content: { type: string; text: string }[] }) => number | null
}
/** 缓存由宿主持有；规则目录与动作结构由引擎生成。 */
export interface RequestPlanningAnalysis<R extends PlanningRequest, B extends PlanningBlock> {
  cloned(before: R['messages'], after: R['messages']): void
  changed(message: R['messages'][number]): void
  blockIndex(blocks: readonly B[]): ReturnType<typeof indexRequestBlocks<B>>
  actionIndex(actions: readonly V2Action[]): RequestActionStages<V2Action>
  read(request: R): { hasEmptyMessages: boolean }
  pairIndex(request: R): RequestPairs
  impact(before: R, after: R): RequestImpact
}
export interface RequestPlanInput<R extends PlanningRequest, B extends PlanningBlock> {
  request: R
  blocks: readonly B[]
  rules: readonly NormalizedRuleV2[]
  events: readonly RuleEvent[]
  templates: PlanningTemplates
  snapshot: PlanningSnapshot
  decision(event: RuleEvent, action: V2Action): PlanningDecision
  /** 每次同步准备重开控制批次；Worker 等待不持有批次内的游标。 */
  withDecisions?<T>(run: (decision: RequestPlanInput<R, B>['decision']) => T): T
  ports: RequestPlanningPorts<R, B>
  analysis?: RequestPlanningAnalysis<R, B>
  maxInjectedChars?: number
  maxRequestBytes?: number
  maxInjectedTokens?: number
  maxCacheChangedBytes?: number
  impactBaseline?: R
}
