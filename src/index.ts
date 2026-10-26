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

export { applyRules } from './apply.js'
export type { ApplyInput, ApplyOutput } from './apply.js'

export { createEngine } from './engine.js'
export type {
  Engine, EngineOptions, EngineContext, EngineRecord, DeliveryPayload, ConsumerInput, RunInput, RunOutput,
} from './engine.js'

export {
  V2_STAGES,
  V2_ACTIONS,
  readBinding,
  bindInputs,
  normalizeRuleV2,
  selectBlocksV2,
  matchConditionV2,
  detectRulesV2,
  validateDetectorEvidenceV2,
  applyBlockPatchesV2,
} from './v2.js'
export type {
  V2Stage, V2ActionKind, ConditionNode, V2Block, V2Segment, SelectFilter, V2Target, V2Action,
  NormalizedRuleV2, MatchEvidence, ConditionSnapshot, RuleEvent, BlockPatch, PatchResult, PatchOutput,
  DetectInput, PatchableBlock,
} from './v2.js'

export type {
  ActionKind, ArgsCondition, Gate, GateVerdict, Hit, IdleCondition, Macros, NormalizedRule,
  NumberComparison, NumberCondition, RuleAction, RuleDefaults, RuleWhen, Surface,
} from './types.js'
