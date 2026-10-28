/**
 * DSH 专用的规则引擎。
 *
 * 提供规则校验、匹配、文本变换与有状态调度。
 * 输入「规则集 + 事件/上下文」，输出「该做什么」，不依赖 DSH 运行时。
 * 消费者各自把结果接走：context_care 取 notify，fetch-router 取 transform。
 *
 * 分层：
 *   placement.js  作用位置与作用域常量
 *   regex.js      正则编译、替换、宏替换（搬运自酒馆正则扩展）
 *   rules.js      规则的校验与规范化（非法直接抛错）
 *   match.js      触发条件匹配（全部 AND）
 *   budget.js     前缀缓存的字节级估算与预算驱动的收缩
 *   apply.js      把规则作用在一段文本上（纯函数）
 *   engine.js     规则来源、消费者注册、冷却与去重、命中日志
 */

export { PLACEMENT, PLACEMENTS, SCOPE, SCOPES, isPlacement, isScope } from './placement.js'
export type { Placement, Scope } from './placement.js'

export { isRecord, isUnknownArray, isStringArray } from './guard.js'
export { requestImpact, publicRequestBytes, estimateInjection } from './request-impact.js'
export { ownRequestMessageBody, setRequestBlock } from './request-payload.js'
export { indexRequestPairs, createRequestPairProjection } from './request-pairs.js'
export type { RequestPairPayload } from './request-pairs.js'
export { createRequestModelProjection } from './request-model-projection.js'
export { createRequestPlanCache } from './request-plan-cache.js'
export { createDisplayPlanCache } from './display-plan-cache.js'
export type { PlanningCachePort, PlanningCacheKey } from './planning-cache.js'

export {
  RegexProvider,
  defaultRegexProvider,
  regexFromString,
  sanitizeRegexMacro,
  isRegexLiteral,
  resolveFindRegex,
  identityMacros,
  filterString,
  runRegexScript,
  SUBSTITUTE_FIND_REGEX,
  DEFAULT_REGEX_CACHE_SIZE,
} from './regex.js'
export type { SubstituteMode, FilterOptions, RegexScript, RunOptions } from './regex.js'

export {
  DEFAULT_RULE,
  ACTION_KINDS,
  isActionKind,
  globMatch,
  normalizeRule,
  normalizeRules,
  sortRules,
} from './rules.js'
export type { NormalizeOptions, UnknownFieldPolicy, UnknownFieldReport } from './rules.js'

export {
  matchRule,
  matchArgs,
  matchIdle,
  matchTool,
  matchText,
  matchDepth,
  targetMatches,
  isNumberComparison,
} from './match.js'
export type { MatchContext, MatchSurface, MatchResult, MatchOptions, ToolCallRecord } from './match.js'

export {
  byteLength,
  commonPrefixBytes,
  cacheLossRatio,
  selectWithinBudget,
} from './budget.js'
export type { BudgetPlanInput, BudgetPlan, Replacement } from './budget.js'

export { indexRequestActions } from './request-action-order.js'
export type { RequestActionDependency, RequestActionOrder, RequestActionStages } from './request-action-order.js'
export type { RuleSourceDocument, RuleSourceChange, RuleDocumentPorts } from './source-documents.js'
export type { BooleanCondition } from './condition-tree.js'
export { createBlockPatchPlan } from './display-patch-plan.js'
export { createArgumentPatchState, mergeRequestInsertions } from './request-plan-mutations.js'
export type { RequestInsertion } from './request-plan-mutations.js'
export { indexRequestBlocks, orderRequestRemovals, filteredAncestor } from './request-block-index.js'
export type { RequestBlock } from './request-block-index.js'
export { indexFirstRules, groupRulesBySource } from './request-rule-index.js'

export { Variable, Entry, Document, validateDocument, validateDocumentSet, entryRule,
  variableKey, validateVariableValue, variableSnapshot, documentDeclarations, documentDefinitions, RuleStateError } from './declarations.js'
export { actionAvailability } from './availability.js'
export { assertFileRevision } from './document-revisions.js'
export { createDocumentRegistry } from './document-registry.js'
export { createBlockWindow } from './block-window.js'
export type { BlockAddress, BlockProjection } from './block-window.js'
export { createDeltaProjection } from './delta-projection.js'
export { openDeltaRuntime } from './delta-runtime.js'
export type { DeltaRuntimePorts } from './delta-runtime.js'
export { actionRunRecords, isActionRunRecord } from './run-records.js'
export { recordRuleFailure, displayPlanningFailure } from './runtime-diagnostics.js'
export { observationPolicy, acknowledgeObservation, markDisplayChange } from './observation-policy.js'
export type { ObservationEvent } from './observation-policy.js'
export { documentTemplates } from './declarations.js'
export { compileSnapshotCondition, parseSnapshotCondition, evaluateSnapshotCondition, clampCountLimits, CountLimits, TextSamples } from './snapshot-conditions.js'
export type { SnapshotCondition, SnapshotMatch, CountLimitValues, TextSampleValue } from './snapshot-conditions.js'
export { TextCountConfig, measureTextCount, negateTruth, combineTruth } from './text-count.js'
export type { MatchTruth, TextCountResult, TextCountOptions, TextCounts } from './text-count.js'
export { markdownStatements, projectText, textStatements } from './text-projection.js'
export type { TextSpan } from './text-projection.js'
export { OutputPatternConfig, detectOutputPatterns, patternTrigger } from './output-patterns.js'
export type { OutputPatternOptions, OutputPatternResult, OutputPatternSample, OutputPatternHit } from './output-patterns.js'
export { ScopedPromptConfig, resolveScopedPrompts, selectScopedPrompts } from './scoped-prompts.js'
export type { ScopedPrompt } from './scoped-prompts.js'
export { createNoticeRuleRuntime } from './notice-rules.js'
export type { NoticeRuleInput, NoticeRuleTrace, NoticeRuleRecord, NoticeRuleRuntimeOptions } from './notice-rules.js'
export { createNoticeChannel } from './notice-channel.js'
export type { NoticeContext, NoticeValue, NoticeControls, NoticeRegistrant, NoticeDescriptor } from './notice-channel.js'
export { parseCompletion, completionStateKey, createCompletionObserver, CompletionConfig, CompletionObservationState, COMPLETION_STATE_DOMAIN } from './completion-observation.js'
export type { CompletionCandidate, CompletionObservation, CompletionObserverOptions } from './completion-observation.js'
export { createCompletionFeedback } from './completion-feedback.js'
export type { CompletionRequest, CompletionNotice, CompletionSegment, CompletionFact, CompletionFactRead, CompletionFeedbackOptions } from './completion-feedback.js'
export { createCompletionOutbox, COMPLETION_NOTICES_DOMAIN } from './completion-outbox.js'
export type { CompletionTable } from './completion-outbox.js'
export { loopNeedsReminder, shouldNotify, createStreamNoticePolicy, createStreamNoticeActions } from './notice-policy.js'
export type { StreamNoticePorts, StreamNoticeInput } from './notice-policy.js'
export { cleanTail, cleanMessage, cleanMessages, CLEAN_PATTERNS } from './loop-clean.js'
export { createRequestRewriter, REWRITER_NAME } from './request-rewriter.js'
export type { RequestRewriteOptions, RewriteBlockEvidence, LoopRewriteRecord } from './request-rewriter.js'
export { createOutputFeedback } from './output-feedback.js'
export type { FeedbackRoute, OutputFeedbackBounds, OutputFeedbackRule, OutputFeedbackMetrics, OutputFeedbackEpisode, OutputFeedbackSegment, OutputFeedbackSession, OutputFeedbackFact, OutputFeedbackFactRead, OutputFeedbackCachePort, OutputFeedbackOptions } from './output-feedback.js'
export { schemaError, parseOrThrow } from './schema-error.js'
export { normalizeScope, matchesScope } from './recipient-scope.js'
export type { RecipientCondition, RecipientFacts, RecipientIdentity, RecipientScope } from './recipient-scope.js'
export { RuleLimit, CapacitySettings, CapacityWire, CapacityError } from './catalog-capacity.js'
export { createEventRuntime, deliveryMessageSource } from './event-runtime.js'
export type { DeliveryMessage, EventRuntime, EventSourceInput, EventSourceHandle } from './event-runtime.js'
export { EventRule, EventSource, compileEventActions, normalizeEventRule, deliveryAction } from './event-rules.js'
export type { ScheduledAction as EventAction, DeclaredEvents, EventCatalog } from './event-rules.js'
export { Recipient, EventSelector, DeliveryPolicy, DeliveryConfig, RuleJudge } from './event-policy.js'
export { Event as RuleEventInput, Detector as EventDetector, SessionState as DeliveryState, MatchResult as EventMatchResult, BatchAnswer, BatchResult, AnalysisFacts, REMINDER_DOMAIN, triggerKey, jsonCopy, errorMessage, errorDetail } from './event-state.js'
export type { CandidateValue, StateValue as DeliveryStateValue, StickyStateValue, EventValue, SourceValue as EventSourceValue, RuleValue as EventRuleValue, DetectorValue as EventDetectorValue, RegisteredSource as EventRegisteredSource, WorkItem as EventWorkItem, Run as EventRun, RuntimeOptions as EventRuntimeOptions, EventOptions, Work as EventWork, BatchRuleInput, RequestInput as EventRequestInput, CollectInput as EventCollectInput, ToolPreparation, HandoffRule, OutputHandoffRule, HandoffLookup } from './event-state.js'
export { ClaimBook, CLAIM_DOMAIN, quotaFor, changeClaims, hasClaim } from './delivery-claims.js'
export type { ClaimBookValue, SharedQuota, QuotaCandidate, Reservation, ClaimOperation } from './delivery-claims.js'
export { localWindow, requestContext, requestEligible, humanActivity } from './event-context.js'
export type { MessageView, HistoryView, HistoryEvent } from './event-context.js'
export { evaluateRules, parseRuleAnswer } from './event-evaluation.js'
export type { RuleAnswer } from './event-evaluation.js'
export { createPersistenceOwner, isDefiniteStorageFailure, PersistenceTimeoutError } from './persistence-owner.js'
export type { PersistenceTransaction } from './persistence-owner.js'
export { createDenialTickets, openPreExecution, codeForReason, codeForFailure } from './execution-tickets.js'
export type { DenialVerdict, PreExecution, UnfinishedCode } from './execution-tickets.js'
export { shutdownEventRuntime } from './runtime-shutdown.js'
export { deliveryHandoff, candidateFromMessage } from './delivery-handoff.js'
export { executeEventMatch, executeEventBatch } from './event-matcher.js'
export { createCustomEvents } from './event-catalog.js'
export { recordedDelivery, recordedDeliveryStage } from './recorded-delivery.js'
export { restoreDeliveryState, restoreDeliveryEntries } from './delivery-restore.js'
export { recordDeliveryClaim, validateDeliveryClaims } from './claim-projection.js'
export { emptyDeliveryProjection, applyDeliveryFact, readDeliveryProjection, deliveryHanded, rememberDeliveryTrigger } from './delivery-projection.js'
export type { DeliveryProjection, DeliveryFactMessage, DeliveryFactEvent, DeliveryFoldPorts } from './delivery-projection.js'
export { createClaimRuntime } from './claim-runtime.js'
export type { ClaimMessage, ClaimFact, ClaimFactType, ClaimRead, ClaimRuntimeOptions } from './claim-runtime.js'
export { createDeliveryRuntime } from './delivery-runtime.js'
export type { DeliverySession, DeliveryFactType, DeliveryObservation, DeliveryLog, DeliveryCachePort, DeliveryRuntimeOptions } from './delivery-runtime.js'
export { emptyQueuedDeliveryProjection, applyQueuedDeliveryFact, isQueuedDelivery, queuedDeliveryMessages } from './delivery-projection.js'
export type { QueuedDeliveryProjection, QueuedDeliveryFact } from './delivery-projection.js'
export { planDeliveryInputs, collectDeliveryInputs, filterDeliveryMessages, handoffQueuedDelivery } from './delivery-transactions.js'
export type { DeliveryFilterOptions, DeliveryCommitOptions, QueuedHandoffOptions } from './delivery-transactions.js'
export { SNOOZE_FORMAT, SnoozeWindow, SnoozeResult, snoozeResultSchema, createSnoozeResult, readSnoozeResult } from './snooze-facts.js'
export type { SnoozeWindowValue, SnoozeResultValue } from './snooze-facts.js'
export { createOutputInterrupt } from './output-interrupt.js'
export { createOutputProjection } from './output-projection.js'
export { createOutputStream } from './output-stream.js'
export type { OutputConfig, OutputEvidence, OutputEvent, OutputFrame as OutputFrameInput, StreamChunk as ReadableStreamChunk } from './output-stream.js'
export type { CustomEventDescriptor } from './event-catalog.js'
export { selectorPaths, sessionEventShape, unresolvableSegment } from './event-selectors.js'
export type { EventFieldShape } from './generated/event-field-shape.js'
export type { RuleFailure } from './runtime-diagnostics.js'
export type { DeltaProjectionOptions, DeltaChunk, DeltaBlock, DeltaOccurrence } from './delta-projection.js'
export type { DocumentRegistryOptions, DocumentContribution, RuleFile } from './document-registry.js'
export { withPlanningToken } from './planning-token.js'
export { importWorkbench, importTavernRegex, importDeclarations } from './import-declarations.js'
export type { RuleExtension } from './rule-extensions.js'
export type { DeclarationImport } from './import-declarations.js'
export type { RuleDocument, RuleEntry, RuleVariable } from './declarations.js'
export { entryPolicy, deliveredEntry, deactivatedEntry } from './entry-lifecycle.js'
export type { EntryMoment } from './entry-lifecycle.js'
export { createActionRuns, compactExecutorRef } from './action-runs.js'
export type { ActionRunOptions, ActionRunPorts, ActionExecutor } from './action-runs.js'
export { createExecutorRegistry } from './executors.js'
export type { ExecutorDeclaration, ExecutorPorts, RegisteredExecutor } from './executors.js'
export { createActionCapacity, awaitApproval } from './action-capacity.js'
export { ControlSource, StoredControls, ControlPatch, createRuleControls } from './rule-controls.js'
export type { RuleControls, ControlOptions, ControlSelect } from './rule-controls.js'
export { indexFirstControlIds, indexControlSources, createControlPreferenceIndex } from './control-decision-index.js'
export { createBoundedMatcher, MatcherFailure } from './matcher-pool.js'
export type { MatcherOptions, MatcherTiming, MatcherDiagnostic, InterruptedRule } from './matcher-pool.js'
export { progressWriter, createProgress, readProgress, milliseconds, nanoseconds } from './matcher-progress.js'
export type { ProgressSnapshot, ExecutionCheckpoint } from './matcher-progress.js'
export { planStage } from './stage-plan.js'
export { selectStageRules, selectToolDenial, assertPlanCurrent } from './stage-selection.js'
export type { StagePlanInput, StageSnapshot, EntryPolicies, EntryTransition } from './stage-plan.js'
export { dispatchItems, recoverDispatches, reserveDispatch, rollbackDispatch, unknownDispatch, handoffDispatch, settleDispatch, hasDispatch } from './dispatch-state.js'
export { actionKey, dispatchKey, decideRuntimeAction, requestViews, entryDirectory, writeActionVariable } from './runtime-policy.js'
export type { RuntimePolicyInput, VariableTransitionPorts } from './runtime-policy.js'
export { createDetectorRegistry } from './detector-registry.js'
export type { DetectionInput, DetectionOptions, DetectionMatcher } from './detector-registry.js'
export { createWorkerDetectors } from './detector-worker.js'
export { detectorValidator, validateDetectorValue, assertDetectorJson, detectorCallbackSource } from './detector-protocol.js'
export type { DetectorSpecification, DetectorStates, DetectorHeldState, DetectorCallbackName } from './detector-protocol.js'
export { builtinDetectorSpecifications, builtinDetectorCallbacks } from './builtin-detectors.js'
export { executeRuleTask, runRuleWorker } from './rule-worker.js'
export type { RuleWorkerContext, RuleWorkerOptions } from './rule-worker.js'
export { createStreamWatch, createView, appendText, viewTail, DETECTORS, TEXT_LIMIT, LINE_WINDOW, MIN_LINE_LEN, LINE_LIMIT, WINDOWED_EVERY } from './stream-watch.js'
export { detectDegradation, describeHit, fenceMask, PATTERN_IDS, CLEANABLE_IDS } from './loop-patterns.js'
export type { LoopHit } from './loop-patterns.js'
export { serializeWorkerError } from './worker-error.js'
export type { WorkerError } from './worker-error.js'
export { StoredRules, createRuleStore } from './rule-store.js'
export type { RuleStore, RuleStoreRecord, RuleStoreOptions, RuleStoreEdit } from './rule-store.js'
export type { EngineRuntime, ActionState, ActionRunRecord, ActionWorkItem } from './runtime-types.js'
export { createTemplates } from './templates.js'
export type { TemplateOptions, TemplatePartial, TemplateHelper } from './templates.js'
export { planRequest, planRequestAsync } from './request-plan.js'
export type { TextTransformExecutor } from './text-transform-plan.js'
export { planDisplay, planDisplayAsync } from './display-plan.js'
export type { DisplayPlanInput, DisplayPlanningAnalysis } from './display-plan.js'
export { indexDisplayBlocks, mergeDisplayInsertions } from './display-index.js'
export type { DisplayBlockIdentity, DisplayInsertion } from './display-index.js'
export type { PlanningRequest, PlanningMessage, PlanningBlock, DisplayBlock, PlanningTemplates, PlanningSnapshot, PlanningDecision,
  PlanningRecord, PlannedAction, ScheduledAction, RequestPlanInput, RequestPlanningPorts, RequestPlanningAnalysis, RequestImpact, RequestPairs } from './planning-types.js'

export { applyRules } from './apply.js'
export type { ApplyInput, ApplyOutput } from './apply.js'

export { createEngine } from './engine.js'
export type {
  Engine, RuleQuery, EngineOptions, EngineContext, EngineRecord, DeliveryPayload, ConsumerInput, RunInput, RunOutput,
} from './engine.js'

export {
  V2_STAGES,
  V2_ACTIONS,
  readBinding,
  bindInputs,
  normalizeRuleV2,
  hasStageRules,
  normalizeCondition,
  selectBlocksV2,
  matchConditionV2,
  detectRulesV2,
  validateDetectorEvidenceV2,
  applyBlockPatchesV2,
} from './block-rules.js'
export type {
  RuleDeclaration, ActionDeclaration, ConditionDeclaration, ConditionExtensionDeclaration, ActionExtensionDeclaration, V2Stage, V2ActionKind, ConditionNode, V2Block, V2Segment, SelectFilter, V2Target, V2Action,
  NormalizedRuleV2, MatchEvidence, ConditionSnapshot, RuleEvent,
  DetectInput, PatchableBlock,
} from './block-rules.js'
export type { BlockPatch, PatchResult, PatchOutput } from './patch-types.js'

export type {
  ActionKind, ArgsCondition, Gate, GateVerdict, Hit, IdleCondition, Macros, NormalizedRule,
  NumberComparison, NumberCondition, RuleAction, RuleDefaults, RuleWhen, Surface,
} from './types.js'
