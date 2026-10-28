import { z } from 'zod'
import { isRecord } from './guard.js'
import { ArgumentFacts, IdleFact, NumberFacts } from './condition-schema.js'
import { InputRecord, parseInput } from './input-schema.js'
import { globMatch } from './rules.js'
import { isRegexLiteral, regexFromString } from './regex.js'
import type { MatchContext } from './match.js'
import type { NumberComparison } from './types.js'

export { normalizeFactCondition } from './condition-schema.js'
import type { FactConditionNode } from './condition-schema.js'
export type { FactConditionNode } from './condition-schema.js'

/** 事实谓词由文本、块和事件条件共同调用；这里只解释值，不保存调用状态。 */
export function matchFactCondition(node: FactConditionNode, snapshot: Record<string, unknown>, read: (field: string) => unknown): boolean {
  if (node.kind === 'surface') {
    const surface = isRecord(snapshot.surface) ? snapshot.surface : {}
    if (node.placement.length && !node.placement.includes(String(surface.placement))) return false
    if (!surfaceTarget(node, surface)) return false
    if (surface.isEdit === true && !node.runOnEdit) return false
    return surfaceDepth(node.minDepth, node.maxDepth, surface.depth)
  }
  if (node.kind === 'numbers') return matchNumbers(node.values, snapshot)
  if (node.kind === 'idle') return matchIdle(node, snapshot)
  let actual: unknown
  try { actual = read(node.field) } catch (error) {
    // 缺失的可选路由/文本/参数仍沿用各自的“不命中”语义；其它错误不能吞掉。
    if (!(error instanceof Error) || !error.message.startsWith('rules-v2: missing binding')) throw error
  }
  if (node.kind === 'arguments') return matchArgs(node.contains, actual)
  if (node.kind === 'glob') return matchTool(node.pattern, typeof actual === 'string' ? actual : undefined)
  if (actual !== undefined && actual !== null && typeof actual !== 'string') throw new TypeError('dsh-rule-engine: matchText expects a string to search in')
  return matchText(node.pattern, actual ?? '')
}
/** 三态目标与深度同时服务同步文本和 Worker 条件，保留缺少深度时的放行语义。 */
export function surfaceTarget(rule: { markdownOnly: boolean; promptOnly: boolean }, surface: { isMarkdown?: unknown; isPrompt?: unknown }): boolean {
  const markdown = surface.isMarkdown === true, prompt = surface.isPrompt === true
  return rule.markdownOnly && markdown || rule.promptOnly && prompt || !rule.markdownOnly && !rule.promptOnly && !markdown && !prompt
}
export function surfaceDepth(min: number | null, max: number | null, depth: unknown): boolean {
  if (depth === undefined) return true
  if (typeof depth !== 'number' || !Number.isFinite(depth)) throw new TypeError('dsh-rule-engine: depth must be a finite number')
  return (min === null || depth >= min) && (max === null || depth <= max)
}
export function matchText(pattern: string, text: string): boolean {
  if (typeof pattern !== 'string' || !pattern.length) throw new TypeError('dsh-rule-engine: matchText expects a non-empty pattern string')
  if (typeof text !== 'string') throw new TypeError('dsh-rule-engine: matchText expects a string to search in')
  if (!text.length) return false
  return isRegexLiteral(pattern) ? regexFromString(pattern).test(text) : text.includes(pattern)
}
export function matchTool(pattern: string | readonly string[], name?: string): boolean {
  if (typeof pattern === 'string') return globMatch(pattern, name)
  if (!pattern.length) throw new TypeError('dsh-rule-engine: when.tool must not be an empty array')
  return pattern.some(item => globMatch(item, name))
}
export function matchArgs(expect: unknown, args?: unknown): boolean {
  const wanted = parseInput(ArgumentFacts, expect, 'matchArgs')
  const actual = args === null || args === undefined ? undefined : parseInput(InputRecord, args, 'tool args')
  for (const [key, want] of Object.entries(wanted)) {
    const value = actual?.[key]
    if (value === undefined || value === null) return false
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    for (const item of Array.isArray(want) ? want : [want]) {
      if (!text.includes(item)) return false
    }
  }
  return true
}
export function matchIdle(idle: unknown, ctx: MatchContext): boolean {
  const spec = parseInput(IdleFact.strip(), idle, 'idle')
  const calls = ctx.toolCalls == null ? [] : parseInput(z.array(z.unknown()), ctx.toolCalls, 'ctx.toolCalls')
  let lastAt: number | undefined
  for (const call of calls) if (isRecord(call) && call.name === spec.since && typeof call.at === 'number') lastAt = call.at
  if (lastAt === undefined) return false
  if (typeof ctx.now !== 'number' || !Number.isFinite(ctx.now)) throw new TypeError('dsh-rule-engine: ctx.now must be a number when an idle condition is used')
  return ctx.now - lastAt >= spec.minutes * 60000
}
export const NUMBER_COMPARISONS: Readonly<Record<NumberComparison, (value: number, bound: number) => boolean>> = Object.freeze({
  gte: (value, bound) => value >= bound, gt: (value, bound) => value > bound,
  lte: (value, bound) => value <= bound, lt: (value, bound) => value < bound, eq: (value, bound) => value === bound,
})
export function isNumberComparison(value: unknown): value is NumberComparison {
  return typeof value === 'string' && Object.hasOwn(NUMBER_COMPARISONS, value)
}
export function matchNumbers(expect: unknown, ctx: MatchContext): boolean {
  const numbers = parseInput(NumberFacts, expect, 'numbers')
  const metrics = Object.keys(numbers)
  for (const metric of metrics) {
    const value = ctx[metric]
    if (value === null) return false
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('dsh-rule-engine: ctx.' + metric + ' must be a finite number (or null when it is unknown) when numbers.' + metric + ' is used')
    for (const [operator, bound] of Object.entries(numbers[metric])) {
      if (isNumberComparison(operator) && bound !== undefined && !NUMBER_COMPARISONS[operator](value, bound)) return false
    }
  }
  return true
}
