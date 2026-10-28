/**
 * 跨模块共享的数据形状。
 *
 * 只放类型，不放运行时代码 —— 避免任何循环依赖。
 * 这里的每个字段都对应 normalizeRule 的一项校验：类型可信的前提是已经规范化。
 */

import type { z } from 'zod'
import type { Placement } from './placement.js'
import type { V2Action } from './block-rules.js'
import type { StageFields } from './stage-schema.js'
import type { ArgumentFacts, IdleFact, NumberComparisons, NumberFacts } from './condition-schema.js'
import type { TextAction, TextRuleFields, TextWhen } from './text-rule-schema.js'

/** 规则动作类型。 */
export type ActionKind = z.infer<typeof TextAction>['kind']

/** 支持的数值比较符。 */
export type NumberComparison = keyof z.infer<typeof NumberComparisons>

/** 待处理的一段文本。引擎不关心它从哪来。 */
export interface Surface {
  /** 这段文本在上下文里的位置。 */
  placement: Placement
  /** 正文。 */
  text: string
}

/** 宏替换：把 {{user}} 这类占位替换掉。 */
export type Macros = (text: string, transform?: (value: string) => string) => string

/** 只读集合视图来自同一 schema，不另列条件字段。 */
type ReadonlyValues<T> = T extends readonly unknown[] ? Readonly<T>
  : T extends object ? { readonly [K in keyof T]: ReadonlyValues<T[K]> } : T
export type IdleCondition = z.infer<typeof IdleFact>
export type NumberCondition = ReadonlyValues<z.infer<typeof NumberFacts>>
export type ArgsCondition = ReadonlyValues<z.infer<typeof ArgumentFacts>>
type WhenShape = z.infer<typeof TextWhen>
type CollectionView<T> = T extends readonly unknown[] ? Readonly<T> : T
export type RuleWhen = { [K in keyof WhenShape]: K extends 'args' ? ArgsCondition : K extends 'numbers' ? NumberCondition : CollectionView<WhenShape[K]> }
/** 同步消费者可携带字段，所有共同字段仍从动作 schema 推导。 */
export type RuleAction = z.infer<typeof TextAction> & Record<string, unknown>

/** 多动作声明本身是可执行序列；没有伪造的单动作通知。 */
export interface RuleSequence { kind: 'sequence'; actions: readonly V2Action[] }

/** 规范化之后的规则。字段全部有默认值且已通过校验，调用方可以放心读。 */
export type NormalizedRule = z.infer<typeof TextRuleFields> & Partial<Omit<StageFields, 'id'>> & {
  when: RuleWhen
  action: RuleAction | RuleSequence
}

/** 一条命中记录。 */
export interface Hit {
  ruleId: string
  kind: ActionKind
  placement: Placement
  applied: boolean
  outcome?: string
  detail?: string
  changed?: boolean
  loss?: number
  action?: RuleAction
}

/** 准入判定的返回。undefined 表示放行。 */
export interface GateVerdict {
  ok: boolean
  outcome?: string
  detail?: string
}

/** 额外的准入判定，由宿主注入。 */
export type Gate = (rule: NormalizedRule, surface: Surface) => GateVerdict | undefined

/** 省略字段时用的默认值。这些默认都有明确语义：「没说就是不做 / 不限」。 */
export type RuleDefaults = ReadonlyValues<Omit<z.infer<typeof TextRuleFields>, 'id' | 'order' | 'budget'>>
