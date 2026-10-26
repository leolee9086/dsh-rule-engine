/**
 * 规则的校验与规范化。
 *
 * 校验严格：任何一条规则说不清楚，都直接抛错，让调用方拒绝安装、保持原行为
 * （fetch-router 的风格）。为什么不是「跳过坏规则继续跑」：
 * 规则引擎的产物是要发出去的请求，静默跳过一条写坏的规则，
 * 等于让用户以为它在生效 —— 那比报错危险得多。
 *
 * 所以这里不做降级：该给的东西没给就抛错，给了但类型不对也抛错。
 */

import { NUMBER_COMPARISONS, isNumberComparison } from './match.js'
import { SCOPE, isPlacement, isScope, type Placement } from './placement.js'
import { regexFromString, isRegexLiteral, SUBSTITUTE_FIND_REGEX, type SubstituteMode } from './regex.js'
import { isRecord, isUnknownArray } from './guard.js'
import type {
  ActionKind, IdleCondition, NormalizedRule, RuleAction, RuleDefaults, RuleWhen,
} from './types.js'

/** 空的位置列表。单独命名，避免空数组被推断成 never[]。 */
const EMPTY_PLACEMENTS: readonly Placement[] = Object.freeze([])

/** 省略字段时的默认值。这些默认都有明确语义：「没说就是不做 / 不限」。 */
export const DEFAULT_RULE: RuleDefaults = Object.freeze({
  scope: SCOPE.GLOBAL,
  enabled: true,
  placement: EMPTY_PLACEMENTS,
  depth: Object.freeze({ min: null, max: null }),
  markdownOnly: false,
  promptOnly: false,
  runOnEdit: false,
  cooldownMinutes: 0,
  oncePerSurface: false,
})

/** 合法的动作类型。 */
export const ACTION_KINDS: readonly ActionKind[] = Object.freeze(['notify', 'transform'])

/** 判定一个未知值是不是合法动作类型。 */
export function isActionKind(value: unknown): value is ActionKind {
  return ACTION_KINDS.some(kind => kind === value)
}

/** 未知字段的处理策略。 */
export type UnknownFieldPolicy = 'warn' | 'error' | 'drop'

/** 一条未知字段报告。 */
export interface UnknownFieldReport {
  ruleId: string
  /** 字段路径，例如 when.foo / action.template。 */
  path: string
}

/** 规范化选项。未知字段默认直接失败——宽松必须显式选。 */
export interface NormalizeOptions {
  /**
   * 未知字段怎么处理：error 抛错（默认）/ warn 保留并报告 / drop 丢弃。
   * 选 warn 时必须同时给 onUnknownField，否则报告无处可去，等同静默。
   */
  unknownFields?: UnknownFieldPolicy
  /** warn 模式下的报告回调。 */
  onUnknownField?: (report: UnknownFieldReport) => void
}

/** 解析未知字段策略；配置本身说不清就失败。 */
function resolveUnknownPolicy(options: NormalizeOptions): UnknownFieldPolicy {
  const policy = options.unknownFields ?? 'error'
  if (policy !== 'error' && policy !== 'warn' && policy !== 'drop') {
    throw new Error('dsh-rule-engine: unknownFields must be "error", "warn" or "drop"')
  }
  if (policy === 'warn' && options.onUnknownField === undefined) {
    throw new Error('dsh-rule-engine: unknownFields "warn" needs onUnknownField — otherwise the report would be silently lost (use "error" or "drop")')
  }
  return policy
}

/** 规则顶层的已知字段。 */
const RULE_KEYS: ReadonlySet<string> = new Set([
  'id', 'scope', 'order', 'enabled', 'when', 'action', 'placement', 'depth',
  'markdownOnly', 'promptOnly', 'runOnEdit', 'budget', 'cooldownMinutes', 'oncePerSurface',
])

/** 逐字段校验时保留准确的字段名联合，不靠类型断言访问。 */
const ROUTE_FIELDS: readonly ('provider' | 'model' | 'purpose')[] = ['provider', 'model', 'purpose']
const TEXT_FIELDS: readonly ('said' | 'produced')[] = ['said', 'produced']

/** when 里的已知字段。 */
const WHEN_KEYS: ReadonlySet<string> = new Set([
  'findRegex', 'replaceString', 'substituteRegex', 'trimStrings', 'provider', 'model',
  'purpose', 'tool', 'args', 'idle', 'numbers', 'said', 'produced', 'disabled',
])

/** action 里的已知字段。 */
const ACTION_KEYS: ReadonlySet<string> = new Set(['kind', 'by'])

/** 按策略处理一批未知字段；drop 由调用方在合并时执行。 */
function checkUnknownFields(source: Record<string, unknown>, allowed: ReadonlySet<string>,
  basePath: string, ruleId: string, options: NormalizeOptions): void {
  const policy = resolveUnknownPolicy(options)
  for (const key of Object.keys(source)) {
    if (allowed.has(key)) continue
    const path = basePath === '' ? key : basePath + '.' + key
    if (policy === 'error') {
      throw new Error('dsh-rule-engine: rule "' + ruleId + '" has unknown field ' + path)
    }
    if (policy === 'warn') options.onUnknownField?.({ ruleId, path })
  }
}

/** 合法的宏替换方式。 */
const SUBSTITUTE_MODES: readonly SubstituteMode[] = Object.freeze([
  SUBSTITUTE_FIND_REGEX.NONE,
  SUBSTITUTE_FIND_REGEX.RAW,
  SUBSTITUTE_FIND_REGEX.ESCAPED,
])

/** 判定一个未知值是不是合法宏替换方式。 */
function isSubstituteMode(value: unknown): value is SubstituteMode {
  return SUBSTITUTE_MODES.some(mode => mode === value)
}

/** 收窄成普通对象；形状不对就抛 Error。 */
function expectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message)
  return value
}

/**
 * 判断一个值是否匹配 glob（只支持 `*` 通配）。
 *
 * 与 fetch-router 的 globMatch 同语义：`*` 匹配任意串，不含 `*` 就是全等。
 * provider / model / purpose / tool 这些维度用它，因为它们都是「一族名字」而不是单值。
 */
export function globMatch(pattern: string, value?: string | null): boolean {
  if (typeof pattern !== 'string') {
    throw new TypeError('dsh-rule-engine: globMatch pattern must be a string')
  }
  if (value === undefined || value === null) return false
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp('^' + escaped + '$').test(value)
}

/** 可选布尔字段：没给就用 fallback，给了就必须是布尔。 */
function optionalBoolean(raw: Record<string, unknown>, field: string, fallback: boolean, id: string): boolean {
  const value = raw[field]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new Error('dsh-rule-engine: rule "' + id + '" ' + field + ' must be a boolean')
  }
  return value
}

/** 可选非空字符串：没给就跳过，给了就必须是非空字符串。 */
function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message)
  return value
}

/**
 * 校验并规范化一组规则，返回排好序的数组。
 */
export function normalizeRules(rawRules?: unknown, options: NormalizeOptions = {}): NormalizedRule[] {
  if (rawRules === undefined || rawRules === null) return []
  if (!isUnknownArray(rawRules)) {
    throw new Error('dsh-rule-engine: rules must be an array')
  }
  const seen = new Set<string>()
  const rules = rawRules.map((raw: unknown, index: number) => normalizeRule(raw, index, options))
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new Error('dsh-rule-engine: duplicate rule id "' + rule.id + '"')
    }
    seen.add(rule.id)
  }
  return sortRules(rules)
}

/**
 * 校验并规范化一条规则。
 *
 * @param raw 原始规则（未知形状）。
 * @param index 在数组里的位置（只用于报错时指认是哪一条）。
 */
export function normalizeRule(raw: unknown, index: number, options: NormalizeOptions = {}): NormalizedRule {
  const where = 'rules[' + index + ']'
  const source = expectRecord(raw, 'dsh-rule-engine: ' + where + ' must be an object')
  checkUnknownFields(source, RULE_KEYS, '', String(source.id ?? where), options)
  // id 要显式写：规则可能来自多处，「数组里第几个」在那里不是个稳定的名字。
  const id = source.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('dsh-rule-engine: ' + where + ' needs an explicit non-empty id')
  }

  const scope = source.scope ?? DEFAULT_RULE.scope
  if (!isScope(scope)) {
    throw new Error('dsh-rule-engine: rule "' + id + '" has an unknown scope ' + JSON.stringify(source.scope))
  }

  // 优先级必须显式写出来：规则可能来自静态配置，也可能来自别的插件，
  // 合并之后「谁先声明」这件事根本不存在，拿它当优先级是假的。
  const order = source.order
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    throw new Error('dsh-rule-engine: rule "' + id + '" needs an explicit order (a finite number)')
  }

  const rawPlacement = source.placement ?? DEFAULT_RULE.placement
  if (!isUnknownArray(rawPlacement)) {
    throw new Error('dsh-rule-engine: rule "' + id + '" placement must be an array')
  }
  const placement: Placement[] = []
  for (const spot of rawPlacement) {
    if (!isPlacement(spot)) {
      throw new Error('dsh-rule-engine: rule "' + id + '" has an unknown placement ' + JSON.stringify(spot))
    }
    placement.push(spot)
  }

  const when = checkWhen(source.when ?? {}, id, options)
  const action = checkAction(source.action, id, options)

  // transform 必须说清楚「把什么换成什么」和「能废掉多少缓存」。
  if (action.kind === 'transform') {
    if (typeof when.findRegex !== 'string') {
      throw new Error('dsh-rule-engine: transform rule "' + id + '" needs when.findRegex')
    }
    if (typeof when.replaceString !== 'string') {
      throw new Error('dsh-rule-engine: transform rule "' + id + '" needs when.replaceString (use "" to delete the match)')
    }
  }

  const budget = checkBudget(source.budget, id, action.kind === 'transform')

  const depthSource = source.depth === undefined
    ? expectRecord(DEFAULT_RULE.depth, 'dsh-rule-engine: rule "' + id + '" depth must be an object like { min, max }')
    : expectRecord(source.depth, 'dsh-rule-engine: rule "' + id + '" depth must be an object like { min, max }')
  const rawMin = depthSource.min === undefined ? null : depthSource.min
  const rawMax = depthSource.max === undefined ? null : depthSource.max
  if (rawMin !== null && (typeof rawMin !== 'number' || !Number.isFinite(rawMin))) {
    throw new Error('dsh-rule-engine: rule "' + id + '" depth.min must be a number')
  }
  if (rawMax !== null && (typeof rawMax !== 'number' || !Number.isFinite(rawMax))) {
    throw new Error('dsh-rule-engine: rule "' + id + '" depth.max must be a number')
  }
  const min: number | null = typeof rawMin === 'number' ? rawMin : null
  const max: number | null = typeof rawMax === 'number' ? rawMax : null

  const cooldownMinutes = source.cooldownMinutes ?? DEFAULT_RULE.cooldownMinutes
  if (typeof cooldownMinutes !== 'number' || !Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
    throw new Error('dsh-rule-engine: rule "' + id + '" cooldownMinutes must be a non-negative number')
  }

  return {
    id,
    scope,
    order,
    enabled: optionalBoolean(source, 'enabled', DEFAULT_RULE.enabled, id),
    when,
    action,
    placement,
    depth: { min, max },
    markdownOnly: optionalBoolean(source, 'markdownOnly', DEFAULT_RULE.markdownOnly, id),
    promptOnly: optionalBoolean(source, 'promptOnly', DEFAULT_RULE.promptOnly, id),
    runOnEdit: optionalBoolean(source, 'runOnEdit', DEFAULT_RULE.runOnEdit, id),
    budget,
    cooldownMinutes,
    oncePerSurface: optionalBoolean(source, 'oncePerSurface', DEFAULT_RULE.oncePerSurface, id),
  }
}

/** 校验 action，返回收窄后的动作对象（未知字段原样保留）。 */
function checkAction(raw: unknown, id: string, options: NormalizeOptions): RuleAction {
  const action = expectRecord(raw, 'dsh-rule-engine: rule "' + id + '" needs an action object')
  checkUnknownFields(action, ACTION_KEYS, 'action', id, options)
  const kind = action.kind
  if (!isActionKind(kind)) {
    throw new Error('dsh-rule-engine: rule "' + id + '" action.kind must be "notify" or "transform"')
  }
  const known: RuleAction = { kind }
  if (action.by !== undefined) {
    known.by = requireNonEmptyString(action.by, 'dsh-rule-engine: rule "' + id + '" action.by must be a non-empty string')
  }
  return resolveUnknownPolicy(options) === 'drop' ? known : { ...action, ...known }
}

/** 校验 when 里的每个条件，返回收窄后的条件对象（未知字段原样保留）。 */
function checkWhen(raw: unknown, id: string, options: NormalizeOptions): RuleWhen {
  const when = expectRecord(raw, 'dsh-rule-engine: rule "' + id + '" when must be an object')
  checkUnknownFields(when, WHEN_KEYS, 'when', id, options)
  const known: RuleWhen = {}

  if (when.findRegex !== undefined) {
    if (typeof when.findRegex !== 'string') {
      throw new Error('dsh-rule-engine: rule "' + id + '" when.findRegex must be a string like "/pattern/flags"')
    }
    known.findRegex = when.findRegex
  }
  if (when.replaceString !== undefined) {
    if (typeof when.replaceString !== 'string') {
      throw new Error('dsh-rule-engine: rule "' + id + '" when.replaceString must be a string')
    }
    known.replaceString = when.replaceString
  }
  if (when.substituteRegex !== undefined) {
    if (!isSubstituteMode(when.substituteRegex)) {
      throw new Error('dsh-rule-engine: rule "' + id + '" when.substituteRegex must be 0, 1 or 2')
    }
    known.substituteRegex = when.substituteRegex
  }
  // NONE 模式下正则里没有宏，现在就能编译；RAW / ESCAPED 要等宏替换完才能判，
  // 那种情况只能到运行时再抛错。
  const mode = known.substituteRegex ?? SUBSTITUTE_FIND_REGEX.NONE
  // 编译失败会直接抛错，错误里带原始 pattern；这里不吞也不改写。
  if (typeof known.findRegex === 'string' && mode === SUBSTITUTE_FIND_REGEX.NONE) regexFromString(known.findRegex)
  if (when.trimStrings !== undefined) {
    const trimStrings = when.trimStrings
    if (!isUnknownArray(trimStrings)) {
      throw new Error('dsh-rule-engine: rule "' + id + '" when.trimStrings must be an array of strings')
    }
    const kept: string[] = []
    for (const item of trimStrings) {
      if (typeof item !== 'string' || item.length === 0) {
        throw new Error('dsh-rule-engine: rule "' + id + '" when.trimStrings must not contain an empty or non-string item')
      }
      kept.push(item)
    }
    known.trimStrings = kept
  }
  for (const field of ROUTE_FIELDS) {
    const value = when[field]
    if (value === undefined) continue
    known[field] = requireNonEmptyString(value, 'dsh-rule-engine: rule "' + id + '" when.' + field + ' must be a non-empty string')
  }
  // tool 允许数组：数组表示「其中任意一个」，不是「同时调用」这几个工具。
  if (when.tool !== undefined) {
    const tool = when.tool
    if (typeof tool === 'string') {
      known.tool = requireNonEmptyString(tool, 'dsh-rule-engine: rule "' + id + '" when.tool must be a non-empty string or an array of them')
    } else {
      if (!isUnknownArray(tool)) {
        throw new Error('dsh-rule-engine: rule "' + id + '" when.tool must be a non-empty string or an array of them')
      }
      if (tool.length === 0) {
        throw new Error('dsh-rule-engine: rule "' + id + '" when.tool must not be an empty array')
      }
      const kept: string[] = []
      for (const item of tool) {
        if (typeof item !== 'string' || item.length === 0) {
          throw new Error('dsh-rule-engine: rule "' + id + '" when.tool must be a non-empty string or an array of them')
        }
        kept.push(item)
      }
      known.tool = kept
    }
  }
  for (const field of TEXT_FIELDS) {
    const value = when[field]
    if (value === undefined) continue
    const text = requireNonEmptyString(value, 'dsh-rule-engine: rule "' + id + '" when.' + field + ' must be a non-empty string')
    // 写成 /.../ 就是正则，那就得能编译出来；编译失败的信息由 regexFromString 给出。
    if (isRegexLiteral(text)) regexFromString(text)
    known[field] = text
  }
  if (when.args !== undefined) {
    const args = expectRecord(when.args, 'dsh-rule-engine: rule "' + id + '" when.args must be an object of parameter name to substring')
    const built: Record<string, string | readonly string[]> = {}
    for (const [key, want] of Object.entries(args)) {
      if (typeof want === 'string') {
        built[key] = requireNonEmptyString(want, 'dsh-rule-engine: rule "' + id + '" when.args.' + key + ' must be a non-empty string or an array of them')
        continue
      }
      if (!isUnknownArray(want)) {
        throw new Error('dsh-rule-engine: rule "' + id + '" when.args.' + key + ' must be a non-empty string or an array of them')
      }
      if (want.length === 0) {
        throw new Error('dsh-rule-engine: rule "' + id + '" when.args.' + key + ' must not be an empty array')
      }
      const kept: string[] = []
      for (const item of want) {
        if (typeof item !== 'string' || item.length === 0) {
          throw new Error('dsh-rule-engine: rule "' + id + '" when.args.' + key + ' must be a non-empty string or an array of them')
        }
        kept.push(item)
      }
      built[key] = kept
    }
    known.args = built
  }
  if (when.idle !== undefined) {
    const idle = expectRecord(when.idle, 'dsh-rule-engine: rule "' + id + '" when.idle must be an object like { since, minutes }')
    const since = requireNonEmptyString(idle.since, 'dsh-rule-engine: rule "' + id + '" when.idle.since must be a tool name')
    const minutes = idle.minutes
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
      throw new Error('dsh-rule-engine: rule "' + id + '" when.idle.minutes must be a non-negative number')
    }
    const condition: IdleCondition = { since, minutes }
    known.idle = condition
  }
  // 数值条件的形状现在就能定死：指标名是开放集合（引擎不认识它们），
  // 但「每个指标要给出至少一个已知比较符、边界是有限数」这几条与具体指标无关。
  if (when.numbers !== undefined) {
    const numbers = expectRecord(when.numbers, 'dsh-rule-engine: rule "' + id + '" when.numbers must be an object like { metric: { gte: 60 } }')
    const metrics = Object.keys(numbers)
    if (metrics.length === 0) {
      throw new Error('dsh-rule-engine: rule "' + id + '" when.numbers must name at least one metric')
    }
    const built: Record<string, Readonly<Partial<Record<keyof typeof NUMBER_COMPARISONS, number>>>> = {}
    for (const metric of metrics) {
      const comparisons = expectRecord(numbers[metric], 'dsh-rule-engine: rule "' + id + '" when.numbers.' + metric + ' must be an object of comparisons')
      const operators = Object.keys(comparisons)
      if (operators.length === 0) {
        throw new Error('dsh-rule-engine: rule "' + id + '" when.numbers.' + metric + ' must name at least one comparison')
      }
      const row: Partial<Record<keyof typeof NUMBER_COMPARISONS, number>> = {}
      for (const operator of operators) {
        if (!isNumberComparison(operator)) {
          throw new Error('dsh-rule-engine: rule "' + id + '" when.numbers.' + metric
            + ' has unknown comparison "' + operator + '" (use gte / gt / lte / lt / eq)')
        }
        const bound = comparisons[operator]
        if (typeof bound !== 'number' || !Number.isFinite(bound)) {
          throw new Error('dsh-rule-engine: rule "' + id + '" when.numbers.' + metric + '.' + operator + ' must be a finite number')
        }
        row[operator] = bound
      }
      built[metric] = row
    }
    known.numbers = built
  }
  if (when.disabled !== undefined) {
    if (typeof when.disabled !== 'boolean') {
      throw new Error('dsh-rule-engine: rule "' + id + '" when.disabled must be a boolean')
    }
    known.disabled = when.disabled
  }
  return resolveUnknownPolicy(options) === 'drop' ? known : { ...when, ...known }
}

/** 校验 budget。transform 规则必须给出 maxCacheLoss；notify 规则给了也要合法。 */
function checkBudget(raw: unknown, id: string, required: boolean): { maxCacheLoss: number } {
  if (raw === undefined || raw === null) {
    if (required) throw new Error('dsh-rule-engine: transform rule "' + id + '" needs budget.maxCacheLoss')
    return { maxCacheLoss: 0 }
  }
  const budget = expectRecord(raw, 'dsh-rule-engine: rule "' + id + '" budget must be an object like { maxCacheLoss }')
  const maxCacheLoss = budget.maxCacheLoss
  if (maxCacheLoss === undefined) {
    if (required) {
      throw new Error('dsh-rule-engine: transform rule "' + id + '" needs budget.maxCacheLoss')
    }
    return { maxCacheLoss: 0 }
  }
  if (typeof maxCacheLoss !== 'number' || !Number.isFinite(maxCacheLoss) || maxCacheLoss < 0 || maxCacheLoss > 1) {
    throw new Error('dsh-rule-engine: rule "' + id + '" budget.maxCacheLoss must be a ratio between 0 and 1')
  }
  return { maxCacheLoss }
}

/**
 * 按优先级排序。
 *
 * 优先级 = 作用域优先级 + order，两部分都写在规则里 —— 照搬酒馆的
 * 「ORDER MATTERS: defines the regex script priority」，但去掉酒馆用来兜底的
 * 「列表内顺序」。
 */
export function sortRules(rules: readonly NormalizedRule[]): NormalizedRule[] {
  return [...rules].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope - b.scope
    if (a.order !== b.order) return a.order - b.order
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
}
