/**
 * 触发条件匹配。
 *
 * 全部条件都是 AND —— OR 靠写两条规则，不做通用表达式引擎。
 * 每个不命中都带一个 reason，供日志与面板显示「为什么没触发」。
 *
 * 形状不对的输入（类型错、缺必需字段）一律抛错，不返回 false：
 * 「条件不满足」和「这个条件本身写坏了」是两回事，把它们混成同一个 false，
 * 坏规则就变成了静默失效。
 */

import { globMatch } from './rules.js'
import { regexFromString, isRegexLiteral, resolveFindRegex, identityMacros, defaultRegexProvider, type RegexProvider } from './regex.js'
import type { Macros, NormalizedRule, NumberComparison, Surface } from './types.js'
import { isRecord } from './guard.js'

/** 一次工具调用的记录。 */
export interface ToolCallRecord {
  name: string
  at: number
}

/**
 * 会话级上下文。引擎不解释里面的任何键，只按需读取；
 * 数值指标（when.numbers）的键由提供值的插件定义。
 */
export interface MatchContext {
  provider?: string
  model?: string
  purpose?: string
  toolCalls?: readonly ToolCallRecord[]
  now?: number
  userText?: string
  assistantText?: string
  [key: string]: unknown
}

/** 带目标判定的 surface。 */
export interface MatchSurface extends Surface {
  isEdit?: boolean
  isMarkdown?: boolean
  isPrompt?: boolean
  depth?: number
  tool?: { name?: string; args?: unknown }
}

/** 一次判定的结果。 */
export interface MatchResult {
  ok: boolean
  reason?: string
}

/** matchRule 的可选项。 */
export interface MatchOptions {
  provider?: RegexProvider
  macros?: Macros
}

/** 收窄成普通对象；形状不对就抛 TypeError。 */
function expectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(message)
  return value
}

/**
 * 一条规则在当前这段文本上是否命中。
 *
 * 全部条件都是 AND —— OR 靠写两条规则，不做通用表达式引擎。
 * 每个不命中都带一个 reason，供日志与面板显示「为什么没触发」。
 */
export function matchRule(rule: NormalizedRule, surface: MatchSurface, ctx: MatchContext = {},
  { provider = defaultRegexProvider, macros = identityMacros }: MatchOptions = {}): MatchResult {
  if (typeof rule !== 'object' || rule === null) {
    throw new TypeError('dsh-rule-engine: matchRule expects a rule object')
  }
  if (typeof surface !== 'object' || surface === null) {
    throw new TypeError('dsh-rule-engine: matchRule expects a surface object')
  }
  // 一段文本就是一个 surface；没有文本的 surface（比如只有参数的工具调用）要给空串，不能不给。
  if (typeof surface.text !== 'string') {
    throw new TypeError('dsh-rule-engine: surface.text must be a string (use "" when there is no text)')
  }
  if (!rule.enabled) return { ok: false, reason: 'disabled' }
  if (rule.placement.length > 0 && !rule.placement.includes(surface.placement)) {
    return { ok: false, reason: 'placement' }
  }
  if (!targetMatches(rule, surface)) return { ok: false, reason: 'target' }
  // 编辑历史消息时，只有明确声明 runOnEdit 的规则才跑（照搬酒馆）。
  if (surface.isEdit === true && !rule.runOnEdit) return { ok: false, reason: 'edit' }
  if (!matchDepth(rule, surface.depth)) return { ok: false, reason: 'depth' }

  const when = rule.when
  if (when.provider !== undefined && !globMatch(when.provider, ctx.provider)) {
    return { ok: false, reason: 'provider' }
  }
  if (when.model !== undefined && !globMatch(when.model, ctx.model)) {
    return { ok: false, reason: 'model' }
  }
  if (when.purpose !== undefined && !globMatch(when.purpose, ctx.purpose)) {
    return { ok: false, reason: 'purpose' }
  }
  if (when.tool !== undefined && !matchTool(when.tool, surface.tool?.name)) {
    return { ok: false, reason: 'tool' }
  }
  if (when.args !== undefined && !matchArgs(when.args, surface.tool?.args)) {
    return { ok: false, reason: 'args' }
  }
  if (when.idle !== undefined && !matchIdle(when.idle, ctx)) {
    return { ok: false, reason: 'idle' }
  }
  if (when.numbers !== undefined && !matchNumbers(when.numbers, ctx)) {
    return { ok: false, reason: 'numbers' }
  }
  if (when.said !== undefined && !matchText(when.said, ctx.userText ?? '')) {
    return { ok: false, reason: 'said' }
  }
  if (when.produced !== undefined && !matchText(when.produced, ctx.assistantText ?? '')) {
    return { ok: false, reason: 'produced' }
  }
  if (when.findRegex !== undefined) {
    const regex = provider.get(resolveFindRegex(when, macros))
    if (!regex.test(surface.text)) return { ok: false, reason: 'no-match' }
  }
  return { ok: true }
}

/**
 * markdownOnly / promptOnly 的三态判定，照搬酒馆 getRegexedString 里的那个条件：
 *
 *   - markdownOnly 的规则只对 Markdown（显示）生效
 *   - promptOnly 的规则只对发出去的 prompt 生效
 *   - 两个都不是的规则，只在「既不是 Markdown 也不是 prompt」时生效 ——
 *     因为源（聊天历史）在更早的地方已经改过了，这里不必再来一遍
 */
export function targetMatches(rule: NormalizedRule, surface: MatchSurface): boolean {
  const isMarkdown = surface.isMarkdown === true
  const isPrompt = surface.isPrompt === true
  if (rule.markdownOnly && isMarkdown) return true
  if (rule.promptOnly && isPrompt) return true
  if (!rule.markdownOnly && !rule.promptOnly && !isMarkdown && !isPrompt) return true
  return false
}

/**
 * 深度判定：只对最近 N 条生效（照搬酒馆的 minDepth / maxDepth）。
 * 拿不到 depth 时（调用方没给）一律放行。
 */
export function matchDepth(rule: NormalizedRule, depth?: number): boolean {
  if (depth === undefined) return true
  if (typeof depth !== 'number' || !Number.isFinite(depth)) {
    throw new TypeError('dsh-rule-engine: depth must be a finite number')
  }
  const { min, max } = rule.depth
  if (typeof min === 'number' && depth < min) return false
  if (typeof max === 'number' && depth > max) return false
  return true
}

/**
 * 一段文本里有没有出现某个模式。
 *
 * 模式写成 `/.../flags` 时按正则匹配，否则按子串匹配。
 * 用于 when.said / when.produced：判断某句话在不在用户输入或助手输出里。
 */
export function matchText(pattern: string, text: string): boolean {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new TypeError('dsh-rule-engine: matchText expects a non-empty pattern string')
  }
  if (typeof text !== 'string') {
    throw new TypeError('dsh-rule-engine: matchText expects a string to search in')
  }
  if (text.length === 0) return false
  if (isRegexLiteral(pattern)) {
    return regexFromString(pattern).test(text)
  }
  return text.includes(pattern)
}

/**
 * 工具名匹配。写成数组表示「其中任意一个」—— 要表达的是「这几个工具里哪个被调用了」，
 * 不是「同时调用了这几个」。
 */
export function matchTool(pattern: string | readonly string[], name?: string): boolean {
  if (typeof pattern === 'string') return globMatch(pattern, name)
  if (pattern.length === 0) {
    throw new TypeError('dsh-rule-engine: when.tool must not be an empty array')
  }
  return pattern.some(item => globMatch(item, name))
}

/**
 * 工具参数匹配：参数名 → 子串；数组表示「都要包含」。
 *
 * 例：`{ path: ['D:/dev/src', '.js'] }` —— path 里必须同时出现这两段。
 * 参数值不是字符串时按 JSON 序列化后再找子串。
 */
export function matchArgs(expect: unknown, args?: unknown): boolean {
  const wanted = expectRecord(expect, 'dsh-rule-engine: matchArgs expects an object of parameter name to substring')
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    throw new TypeError('dsh-rule-engine: tool args must be an object')
  }
  const actual = isRecord(args) ? args : undefined
  for (const [key, want] of Object.entries(wanted)) {
    const value = actual === undefined || actual === null ? undefined : actual[key]
    if (value === undefined || value === null) return false
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const wants: readonly unknown[] = Array.isArray(want) ? want : [want]
    for (const item of wants) {
      if (typeof item !== 'string') {
        throw new TypeError('dsh-rule-engine: when.args.' + key + ' must be a string or an array of strings')
      }
      if (!text.includes(item)) return false
    }
  }
  return true
}

/**
 * 空闲匹配：某个工具已经有一段时间没被调用过了。
 *
 * 从来没调用过时返回 false —— 「开局就没调用过」不是「闲置」，
 * 否则所有提醒类规则会在会话开头一起响。
 */
export function matchIdle(idle: unknown, ctx: MatchContext): boolean {
  const spec = expectRecord(idle, 'dsh-rule-engine: matchIdle expects an object like { since, minutes }')
  if (typeof spec.since !== 'string' || spec.since.length === 0) {
    throw new TypeError('dsh-rule-engine: idle.since must be a tool name')
  }
  if (typeof spec.minutes !== 'number' || !Number.isFinite(spec.minutes) || spec.minutes < 0) {
    throw new TypeError('dsh-rule-engine: idle.minutes must be a non-negative number')
  }
  const calls = ctx.toolCalls
  if (calls !== undefined && calls !== null && !Array.isArray(calls)) {
    throw new TypeError('dsh-rule-engine: ctx.toolCalls must be an array of { name, at }')
  }
  let lastAt: number | undefined
  for (const call of calls ?? []) {
    if (call !== null && typeof call === 'object' && call.name === spec.since) lastAt = call.at
  }
  if (lastAt === undefined) return false
  const now = ctx.now
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('dsh-rule-engine: ctx.now must be a number when an idle condition is used')
  }
  return now - lastAt >= spec.minutes * 60000
}

/** 支持的比较符。写别的就抛 —— 静默不匹配会让规则看起来在跑。 */
export const NUMBER_COMPARISONS: Readonly<Record<NumberComparison, (value: number, bound: number) => boolean>> = Object.freeze({
  gte: (value: number, bound: number): boolean => value >= bound,
  gt: (value: number, bound: number): boolean => value > bound,
  lte: (value: number, bound: number): boolean => value <= bound,
  lt: (value: number, bound: number): boolean => value < bound,
  eq: (value: number, bound: number): boolean => value === bound,
})

/** 判定一个字符串是不是已知比较符。 */
export function isNumberComparison(value: unknown): value is NumberComparison {
  return typeof value === 'string' && Object.hasOwn(NUMBER_COMPARISONS, value)
}

/**
 * 数值条件：若干「指标名 → 比较」全部成立才算命中。
 *
 * **引擎不认识任何指标名** —— 它只按 key 从 ctx 里取值再比。键叫什么、谁来填、
 * 什么范围算异常，全由提供值的插件定义。这样以后要加指标不必改引擎。
 *
 * 取不到值就抛，不给默认值：规则看起来在生效、其实一直没跑，比多写几个字段糟得多。
 */
export function matchNumbers(expect: unknown, ctx: MatchContext): boolean {
  const numbers = expectRecord(expect, 'dsh-rule-engine: numbers must be an object like { metric: { gte: 60 } }')
  const metrics = Object.keys(numbers)
  if (metrics.length === 0) {
    throw new TypeError('dsh-rule-engine: numbers must name at least one metric')
  }
  for (const metric of metrics) {
    const value = ctx[metric]
    // 两种「没有值」要分开：
    //   · 键根本不在 ctx 里 —— 规则写了个没人会填的指标，或调用方漏填，属于配置问题，抛；
    //   · 键在、值是 null —— 提供方明确说了「此刻不可知」。
    if (value === null) return false
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('dsh-rule-engine: ctx.' + metric + ' must be a finite number (or null when it is unknown) when numbers.' + metric + ' is used')
    }
    const comparisons = expectRecord(numbers[metric], 'dsh-rule-engine: numbers.' + metric + ' must be an object of comparisons')
    const operators = Object.keys(comparisons)
    if (operators.length === 0) {
      throw new TypeError('dsh-rule-engine: numbers.' + metric + ' must name at least one comparison')
    }
    for (const operator of operators) {
      const bound = comparisons[operator]
      if (typeof bound !== 'number' || !Number.isFinite(bound)) {
        throw new TypeError('dsh-rule-engine: numbers.' + metric + '.' + operator + ' must be a finite number')
      }
      if (!isNumberComparison(operator)) {
        throw new TypeError('dsh-rule-engine: numbers.' + metric + ' has unknown comparison "' + operator
          + '" (use gte / gt / lte / lt / eq)')
      }
      if (!NUMBER_COMPARISONS[operator](value, bound)) return false
    }
  }
  return true
}
