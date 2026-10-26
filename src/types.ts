/**
 * 跨模块共享的数据形状。
 *
 * 只放类型，不放运行时代码 —— 避免任何循环依赖。
 * 这里的每个字段都对应 normalizeRule 的一项校验：类型可信的前提是已经规范化。
 */

import type { Placement, Scope } from './placement.js'

/** 规则动作类型。 */
export type ActionKind = 'notify' | 'transform'

/** 支持的数值比较符。 */
export type NumberComparison = 'gte' | 'gt' | 'lte' | 'lt' | 'eq'

/** 待处理的一段文本。引擎不关心它从哪来。 */
export interface Surface {
  /** 这段文本在上下文里的位置。 */
  placement: Placement
  /** 正文。 */
  text: string
}

/** 宏替换：把 {{user}} 这类占位替换掉。 */
export type Macros = (text: string, transform?: (value: string) => string) => string

/** 空闲判定：某个工具已经有一段时间没被调用过。 */
export interface IdleCondition {
  /** 工具名。 */
  since: string
  /** 多久没调用算闲置（分钟）。 */
  minutes: number
}

/** 数值条件：指标名 → 该指标要满足的比较。指标名是开放集合，由提供值的插件定义。 */
export type NumberCondition = Readonly<Record<string, Readonly<Partial<Record<NumberComparison, number>>>>>

/** 工具参数条件：参数名 → 子串，数组表示都要包含。 */
export type ArgsCondition = Readonly<Record<string, string | readonly string[]>>

/** 一条规则的 when 条件。全部条件 AND —— OR 靠写两条规则。 */
export interface RuleWhen {
  /** 正则字符串，`/pattern/flags` 或裸 pattern。 */
  findRegex?: string
  /** 替换成什么（空串表示删除）。 */
  replaceString?: string
  /** findRegex 里的宏怎么替换（0 不替换 / 1 替换 / 2 转义后替换）。 */
  substituteRegex?: number
  /** 匹配结果里要剔掉的串。 */
  trimStrings?: readonly string[]
  /** 路由 provider（支持 glob）。 */
  provider?: string
  /** 路由 model（支持 glob）。 */
  model?: string
  /** 请求用途（支持 glob）。 */
  purpose?: string
  /** 工具名或工具名数组（支持 glob，数组表示任意一个）。 */
  tool?: string | readonly string[]
  /** 工具参数子串匹配。 */
  args?: ArgsCondition
  /** 空闲判定。 */
  idle?: IdleCondition
  /** 数值条件。 */
  numbers?: NumberCondition
  /** 用户刚说了什么（子串或正则字面量）。 */
  said?: string
  /** 助手刚输出了什么（子串或正则字面量）。 */
  produced?: string
  /** 这条规则自带禁用开关。 */
  disabled?: boolean
}

/** 规则动作。 */
export interface RuleAction {
  /** 动作类型。 */
  kind: ActionKind
  /** 指名交给哪个消费者；不写就按 kind 广播给所有订阅者。 */
  by?: string
  /** 消费方可以带自己的字段，引擎不解释。 */
  [key: string]: unknown
}

/** 规范化之后的规则。字段全部有默认值且已通过校验，调用方可以放心读。 */
export interface NormalizedRule {
  id: string
  scope: Scope
  order: number
  enabled: boolean
  when: RuleWhen
  action: RuleAction
  placement: Placement[]
  depth: { min: number | null; max: number | null }
  markdownOnly: boolean
  promptOnly: boolean
  runOnEdit: boolean
  /** 缓存预算。notify 规则没有预算诉求时为 { maxCacheLoss: 0 }，字段本身永远存在。 */
  budget: { maxCacheLoss: number }
  cooldownMinutes: number
  oncePerSurface: boolean
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
export interface RuleDefaults {
  readonly scope: Scope
  readonly enabled: boolean
  readonly placement: readonly Placement[]
  readonly depth: { readonly min: number | null; readonly max: number | null }
  readonly markdownOnly: boolean
  readonly promptOnly: boolean
  readonly runOnEdit: boolean
  readonly cooldownMinutes: number
  readonly oncePerSurface: boolean
}
