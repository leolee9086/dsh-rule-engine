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

import { z } from 'zod'
import { isRecord } from './guard.js'
import { InputRecord, parseInput } from './input-schema.js'
import { StageFieldsSchema, normalizeStageFields } from './stage-schema.js'
import { TextRuleFields, TextWhen, TextAction } from './text-rule-schema.js'
import type { ActionKind, NormalizedRule, RuleAction, RuleDefaults, RuleWhen, RuleSequence } from './types.js'

/** 默认值只在 schema 中定义；公开常量只读投影同一组默认值。 */
const defaults = TextRuleFields.omit({ id: true, order: true, budget: true }).parse({})
export const DEFAULT_RULE: RuleDefaults = Object.freeze({ ...defaults, placement: Object.freeze(defaults.placement), depth: Object.freeze(defaults.depth) })

/** 合法的动作类型。 */
export const ACTION_KINDS = Object.freeze([...TextAction.shape.kind.options])

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

/** 字段目录直接来自 schema；包装入口不再复制白名单。 */
const RULE_KEYS = new Set([...Object.keys(TextRuleFields.shape), ...Object.keys(StageFieldsSchema.shape), 'when', 'action'])
const WHEN_KEYS = new Set(Object.keys(TextWhen.shape))
const ACTION_KEYS = new Set(Object.keys(TextAction.shape))

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

/**
 * 校验并规范化一组规则，返回排好序的数组。
 */
export function normalizeRules(rawRules?: unknown, options: NormalizeOptions = {}): NormalizedRule[] {
  if (rawRules === undefined || rawRules === null) return []
  const declarations = parseInput(z.array(z.unknown()), rawRules, 'rules')
  return sortUniqueRules(declarations.map((raw: unknown, index: number) => normalizeRule(raw, index, options)))
}

/** 已规范化产物只检查集合身份并排序，不再解析每个字段。 */
export function sortUniqueRules(rules: readonly NormalizedRule[]): NormalizedRule[] {
  const seen = new Set<string>()
  for (const rule of rules) {
    const identity = rule.schemaVersion === 2 ? JSON.stringify([rule.sourceId, rule.id]) : rule.id
    if (seen.has(identity)) {
      throw new Error('dsh-rule-engine: duplicate rule id "' + rule.id + '"')
    }
    seen.add(identity)
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
  const source = parseInput(InputRecord, raw, 'rules[' + index + ']')
  const id = String(source.id ?? 'rules[' + index + ']')
  checkUnknownFields(source, RULE_KEYS, '', id, options)
  const staged = source.on !== undefined || source.actions !== undefined || source.select !== undefined || source.match !== undefined || source.schemaVersion === 2
  const stageFields = staged ? normalizeStageFields(Object.fromEntries(Object.entries(source).filter(([key]) => Object.hasOwn(StageFieldsSchema.shape, key)))) : undefined
  const fields = parseInput(TextRuleFields, {
    ...source, scope: source.scope ?? DEFAULT_RULE.scope, placement: source.placement ?? [],
    order: source.order ?? (stageFields ? stageFields.priority === 0 ? 0 : -stageFields.priority : undefined),
    cooldownMinutes: source.cooldownMinutes ?? 0, budget: source.budget ?? undefined,
  }, 'rule "' + id + '"')
  const when = checkWhen(source.when ?? {}, id, options)
  const sequence = stageFields && isRecord(source.action) && source.action.kind === 'sequence'
  const action: RuleAction | RuleSequence = stageFields && (source.action === undefined || sequence)
    ? { kind: 'sequence', actions: stageFields.actions } : checkAction(source.action, id, options)
  // 声明间的关系属于规则本身；基础类型与默认值交给 schema。
  if (action.kind === 'transform') {
    if (when.findRegex === undefined) throw new Error('dsh-rule-engine: transform rule "' + id + '" needs when.findRegex')
    if (when.replaceString === undefined) throw new Error('dsh-rule-engine: transform rule "' + id + '" needs when.replaceString (use "" to delete the match)')
    if (!isRecord(source.budget) || source.budget.maxCacheLoss === undefined) throw new Error('dsh-rule-engine: transform rule "' + id + '" needs budget.maxCacheLoss')
  }
  return { ...fields, when, action, ...(stageFields ?? {}) }
}

/** 旧声明保留 warn/drop 策略；验证仍来自同一组 schema。 */
function checkAction(raw: unknown, id: string, options: NormalizeOptions): RuleAction {
  const action = parseInput(InputRecord, raw, 'rule "' + id + '" action')
  checkUnknownFields(action, ACTION_KEYS, 'action', id, options)
  const schema = resolveUnknownPolicy(options) === 'drop' ? TextAction : TextAction.passthrough()
  return parseInput(z.object({ action: schema }), { action }, 'rule "' + id + '"').action
}
function checkWhen(raw: unknown, id: string, options: NormalizeOptions): RuleWhen {
  const when = parseInput(InputRecord, raw, 'rule "' + id + '" when')
  checkUnknownFields(when, WHEN_KEYS, 'when', id, options)
  const schema = resolveUnknownPolicy(options) === 'drop' ? TextWhen : TextWhen.passthrough()
  return parseInput(z.object({ when: schema }), { when }, 'rule "' + id + '"').when
}

/**
 * 规则的排序键。
 *
 * 检测器分两条通路执行（宿主进程 / Worker），两条通路各自排完序以后还要合成一次，
 * 所以「谁先谁后」必须能跨进程传递——只传这份键，不传整条规则。
 */
export interface RuleOrderKey {
  /** 作用域优先级。 */
  scope: number
  /** 已换算成升序的排序值：阶段规则取负 priority，v1 取 order。 */
  order: number
  /** v2 规则的来源；v1 规则没有来源，退回按 ID 比较。 */
  sourceId?: string
  id: string
}
/** 取出规则的排序键；与 compareRules 的比较口径完全一致。 */
export function ruleOrderKey(rule: NormalizedRule): RuleOrderKey {
  // 阶段规则的公开 priority 可由调用方更新；排序不能复用归一化时的旧 order。
  const order = rule.schemaVersion === 2 ? -(rule.priority ?? 0) : rule.order
  return rule.schemaVersion === 2
    ? { scope: rule.scope, order, sourceId: rule.sourceId, id: rule.id }
    : { scope: rule.scope, order, id: rule.id }
}
/**
 * 按优先级排序。
 *
 * 优先级 = 作用域优先级 + order，两部分都写在规则里 —— 照搬酒馆的
 * 「ORDER MATTERS: defines the regex script priority」，但去掉酒馆用来兜底的
 * 「列表内顺序」。
 */
export function compareRuleOrderKey(a: RuleOrderKey, b: RuleOrderKey): number {
  if (a.scope !== b.scope) return a.scope - b.scope
  if (a.order !== b.order) return a.order - b.order
  // 早期阶段声明的同优先级以来源和本地 ID 定序；v1 的词法 ID 比较保持原样。
  if (a.sourceId !== undefined && b.sourceId !== undefined) return a.sourceId.localeCompare(b.sourceId) || a.id.localeCompare(b.id)
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}
export function compareRules(a: NormalizedRule, b: NormalizedRule): number {
  return compareRuleOrderKey(ruleOrderKey(a), ruleOrderKey(b))
}
export function sortRules<T extends NormalizedRule>(rules: readonly T[]): T[] {
  return [...rules].sort(compareRules)
}
