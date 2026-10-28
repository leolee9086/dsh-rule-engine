/**
 * 触发条件匹配。
 *
 * when 的命名字段按顺序合取；when.condition 复用公共组合条件树。
 * 每个不命中都带一个 reason，供日志与面板显示「为什么没触发」。
 *
 * 形状不对的输入（类型错、缺必需字段）一律抛错，不返回 false：
 * 「条件不满足」和「这个条件本身写坏了」是两回事，把它们混成同一个 false，
 * 坏规则就变成了静默失效。
 */

import { z } from 'zod'
import { InputRecord, parseInput } from './input-schema.js'
import { matchConditionV2 } from './block-rules.js'
import { textConditions } from './text-condition.js'
import { surfaceTarget, surfaceDepth } from './condition-facts.js'
import { resolveFindRegex, identityMacros, defaultRegexProvider, type RegexProvider } from './regex.js'
import type { Macros, NormalizedRule, Surface } from './types.js'

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

/**
 * 一条规则在当前这段文本上是否命中。
 *
 * when 的命名字段按顺序合取；when.condition 复用公共组合条件树。
 * 每个不命中都带一个 reason，供日志与面板显示「为什么没触发」。
 */
export function matchRule(rule: NormalizedRule, surface: MatchSurface, ctx: MatchContext = {},
  { provider = defaultRegexProvider, macros = identityMacros }: MatchOptions = {}): MatchResult {
  parseInput(InputRecord, rule, 'matchRule rule')
  parseInput(InputRecord, surface, 'matchRule surface')
  // 只有参数的工具调用显式提供空串；缺少文本依然是输入错误。
  parseInput(z.object({ text: z.string() }), surface, 'surface')
  if (!rule.enabled) return { ok: false, reason: 'disabled' }
  if (rule.placement.length > 0 && !rule.placement.includes(surface.placement)) {
    return { ok: false, reason: 'placement' }
  }
  if (!targetMatches(rule, surface)) return { ok: false, reason: 'target' }
  // 编辑历史消息时，只有明确声明 runOnEdit 的规则才跑（照搬酒馆）。
  if (surface.isEdit === true && !rule.runOnEdit) return { ok: false, reason: 'edit' }
  if (!matchDepth(rule, surface.depth)) return { ok: false, reason: 'depth' }

  const when = rule.when
  const snapshot = { ...ctx, tool: surface.tool, block: { text: surface.text } }
  for (const step of textConditions(when)) {
    if (!matchConditionV2(step.condition, snapshot).ok) return { ok: false, reason: step.reason }
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
  return surfaceTarget(rule, surface)
}

/**
 * 深度判定：只对最近 N 条生效（照搬酒馆的 minDepth / maxDepth）。
 * 拿不到 depth 时（调用方没给）一律放行。
 */
export function matchDepth(rule: NormalizedRule, depth?: number): boolean {
  return surfaceDepth(rule.depth.min, rule.depth.max, depth)
}

export { matchText, matchTool, matchArgs, matchIdle, NUMBER_COMPARISONS, isNumberComparison, matchNumbers } from './condition-facts.js'
