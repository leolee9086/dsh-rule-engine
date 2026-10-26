import { sanitizeRegexMacro } from './regex.js'
import { isRecord, isUnknownArray } from './guard.js'

/** 保留枚举的字面量类型，并冻结同一份运行时枚举值。 */
function enumValues<const T extends readonly string[]>(...values: T): Readonly<T> {
  return Object.freeze(values)
}

/** v2 的触发阶段。 */
export const V2_STAGES = enumValues('request.assemble', 'output.complete', 'tool.result', 'tool.before-execute', 'display.render', 'output.delta')
/** v2 的动作类型。 */
export const V2_ACTIONS = enumValues('notify', 'guidance', 'inject', 'replace', 'filter', 'program', 'tool', 'job', 'set-variable', 'abort', 'resume', 'compact')

/** 一个 v2 触发阶段。 */
export type V2Stage = (typeof V2_STAGES)[number]
/** 一种 v2 动作类型。 */
export type V2ActionKind = (typeof V2_ACTIONS)[number]

const forbidden = new Set(['__proto__', 'prototype', 'constructor'])

/** 未知值必须是普通对象。 */
function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`rules-v2: ${label} must be an object`)
  return value
}
/** 未知值必须是不超过 256 字符的非空字符串。 */
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new TypeError(`rules-v2: invalid ${label}`)
  return value
}
/** 未知值必须是给定枚举里的一个；返回值已经收窄成那个枚举类型。 */
function one<const T extends string>(value: unknown, choices: readonly T[], label: string): T {
  const found = choices.find(choice => choice === value)
  if (found === undefined) throw new TypeError(`rules-v2: unsupported ${label}: ${String(value)}`)
  return found
}
/** 未知值必须是给定范围内的安全整数。 */
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`rules-v2: invalid ${label}`)
  return value
}
/** 不允许出现未声明的键。 */
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`rules-v2: unknown ${label}.${key}`)
}
/** 未知值必须是布尔。 */
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`rules-v2: ${label} must be boolean`)
  return value
}
/** 未知值必须是不超过 limit 字符的字符串。 */
function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || value.length > limit) throw new TypeError(`rules-v2: invalid ${label}`)
  return value
}
/** 未知值必须是合法的 JSON Pointer 或点分路径。 */
function path(value: unknown, label: string): string {
  const raw = text(value, 1024, label)
  const parts = raw.startsWith('/') ? raw.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~')) : raw.split('.')
  if (parts.some(part => forbidden.has(part))) throw new TypeError(`rules-v2: forbidden ${label}`)
  if (!raw || parts.some(part => !part)) throw new TypeError(`rules-v2: invalid ${label}`)
  return raw
}
/** Reject lossy values before clone/queue serialization; plugins must register owned JSON declarations. */
function json(value: unknown, label: string, depth = 0, seen = new Set<object>()): void {
  if (depth > 32) throw new TypeError(`rules-v2: ${label} exceeds JSON nesting limit`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!isRecord(value) && !Array.isArray(value)) throw new TypeError(`rules-v2: ${label} must be acyclic JSON`)
  if (typeof value !== 'object' || value === null) throw new TypeError(`rules-v2: ${label} must be acyclic JSON`)
  if (seen.has(value)) throw new TypeError(`rules-v2: ${label} must be acyclic JSON`)
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`rules-v2: ${label} must be plain JSON`)
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || forbidden.has(key) || descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`rules-v2: invalid ${label} property`)
    json(descriptor.value, label, depth + 1, seen)
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new TypeError(`rules-v2: ${label} must be a dense array`)
  seen.delete(value)
}
/** 绑定声明只允许 { bind: path }，其余位置继续下钻。 */
function bindings(value: unknown, label: string, depth = 0): void {
  if (depth > 32) throw new TypeError(`rules-v2: ${label} exceeds binding nesting limit`)
  if (isRecord(value)) {
    if (Object.hasOwn(value, 'bind')) {
      keys(value, ['bind'], 'binding')
      path(value.bind, 'binding path')
    } else {
      for (const child of Object.values(value)) bindings(child, label, depth + 1)
    }
  } else if (Array.isArray(value)) {
    for (const child of value) bindings(child, label, depth + 1)
  }
}
/** Read own properties only. Missing paths are errors, not invented empty values. */
export function readBinding(root: unknown, path: string): unknown {
  if (typeof path !== 'string' || path.length > 1024) throw new TypeError('rules-v2: invalid binding path')
  const parts = path.startsWith('/') ? path.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~')) : path.split('.')
  let value: unknown = root
  for (const part of parts) {
    if (forbidden.has(part)) throw new Error('rules-v2: forbidden binding path')
    if (isRecord(value)) {
      if (!Object.hasOwn(value, part)) throw new Error(`rules-v2: missing binding ${path}`)
      value = value[part]
    } else if (isUnknownArray(value)) {
      if (!Object.hasOwn(value, part)) throw new Error(`rules-v2: missing binding ${path}`)
      value = value[Number(part)]
    } else {
      throw new Error(`rules-v2: missing binding ${path}`)
    }
  }
  if (value === undefined) throw new Error(`rules-v2: missing binding ${path}`)
  return structuredClone(value)
}
/** Bind JSON values without stringifying numbers, objects, booleans or argv arrays. */
export function bindInputs(input: unknown, snapshot: unknown): unknown {
  json(input, 'inputs'); bindings(input, 'inputs')
  return bound(input, snapshot)
}
/** 递归求值绑定。 */
function bound(input: unknown, snapshot: unknown): unknown {
  if (Array.isArray(input)) return input.map(value => bound(value, snapshot))
  if (isRecord(input)) {
    if (Object.hasOwn(input, 'bind')) {
      keys(input, ['bind'], 'binding')
      return readBinding(snapshot, String(input.bind))
    }
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, value] of Object.entries(input)) {
      if (forbidden.has(key)) throw new Error('rules-v2: forbidden input property')
      result[key] = bound(value, snapshot)
    }
    return result
  }
  if (input === undefined || (typeof input === 'number' && !Number.isFinite(input))) throw new TypeError('rules-v2: inputs must be JSON values')
  return input
}

/** 一个条件节点。所有分支共享 kind 判别字段。 */
export type ConditionNode =
  | { kind: 'always' }
  | { kind: 'all'; conditions: ConditionNode[] }
  | { kind: 'any'; conditions: ConditionNode[] }
  | { kind: 'not'; condition: ConditionNode }
  | { kind: 'regex'; pattern: string; flags: string; field?: string; all?: boolean }
  | { kind: 'keywords'; values: string[]; mode: string; caseSensitive?: boolean; wordBoundary?: boolean; field?: string }
  | { kind: 'compare'; field: string; op: string; value?: unknown }
  | { kind: 'detector'; ref: string; revision: number; params?: unknown }

/** 校验并克隆一个条件节点。 */
function condition(input: unknown, depth = 0): ConditionNode {
  const node = object(input, 'match')
  if (depth > 16) throw new Error('rules-v2: condition nesting exceeds 16')
  const kind = node.kind
  if (kind === 'all' || kind === 'any' || kind === 'not') {
    keys(node, kind === 'not' ? ['kind', 'condition'] : ['kind', 'conditions'], 'match')
    if (kind === 'not') return { kind, condition: condition(node.condition, depth + 1) }
    const children = node.conditions
    if (!isUnknownArray(children) || !children.length || children.length > 64) throw new Error('rules-v2: empty or oversized condition group')
    return { kind, conditions: children.map(child => condition(child, depth + 1)) }
  }
  if (kind === 'regex') {
    keys(node, ['kind', 'pattern', 'flags', 'field', 'all'], 'match')
    if (node.all !== undefined && boolean(node.all, 'match.all') && depth > 0) throw new Error('rules-v2: all regex matches require a root condition')
    const pattern = text(node.pattern, 4096, 'regex pattern')
    if (!pattern) throw new TypeError('rules-v2: invalid regex pattern')
    const flags = text(node.flags ?? '', 8, 'regex flags')
    if (/[^imsu]/.test(flags)) throw new Error('rules-v2: only i/m/s/u regex flags are supported')
    new RegExp(pattern, flags)
    const result: ConditionNode = { kind: 'regex', pattern, flags }
    if (node.field !== undefined) result.field = path(node.field, 'field')
    if (typeof node.all === 'boolean') result.all = node.all
    return result
  }
  if (kind === 'keywords') {
    keys(node, ['kind', 'values', 'mode', 'caseSensitive', 'wordBoundary', 'field'], 'match')
    const values = node.values
    if (!isUnknownArray(values) || !values.length || values.length > 256) throw new TypeError('rules-v2: keywords must be nonempty strings')
    const kept: string[] = []
    for (const value of values) {
      if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError('rules-v2: keywords must be nonempty strings')
      kept.push(value)
    }
    const result: ConditionNode = { kind: 'keywords', values: kept, mode: one(node.mode ?? 'ANY', ['ANY', 'ALL', 'NOT-ANY', 'NOT-ALL'], 'keyword mode') }
    if (node.caseSensitive !== undefined) result.caseSensitive = boolean(node.caseSensitive, 'match.caseSensitive')
    if (node.wordBoundary !== undefined) result.wordBoundary = boolean(node.wordBoundary, 'match.wordBoundary')
    if (node.field !== undefined) result.field = path(node.field, 'field')
    return result
  }
  if (kind === 'compare') {
    keys(node, ['kind', 'field', 'op', 'value'], 'match')
    const field = id(node.field, 'comparison field')
    const op = one(node.op, ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'], 'comparison')
    if (op !== 'exists' && !Object.hasOwn(node, 'value')) throw new TypeError('rules-v2: comparison value is required')
    if (['gt', 'gte', 'lt', 'lte'].includes(op) && typeof node.value !== 'number') throw new TypeError('rules-v2: numeric comparison requires a number')
    const result: ConditionNode = { kind: 'compare', field, op }
    if (op !== 'exists') result.value = structuredClone(node.value)
    return result
  }
  if (kind === 'detector') {
    keys(node, ['kind', 'ref', 'revision', 'params'], 'match')
    if (depth > 0) throw new Error('rules-v2: detectors require a root condition')
    const ref = id(node.ref, 'detector ref')
    const revision = integer(node.revision, 1, Number.MAX_SAFE_INTEGER, 'detector revision')
    if (node.params !== undefined) json(node.params, 'detector params')
    return { kind: 'detector', ref, revision, ...(node.params === undefined ? {} : { params: structuredClone(node.params) }) }
  }
  if (kind === 'always') {
    keys(node, ['kind'], 'match')
    return { kind: 'always' }
  }
  throw new TypeError(`rules-v2: unknown match kind ${String(kind)}`)
}

/** 一个可被规则选中的块。 */
export interface V2Block {
  id: string
  view: string
  role: string
  type: string
  seq: number
  text?: string
  messageId?: string
  turnId?: string
  sessionId?: string
  arguments?: unknown
  raw?: { name?: string; content?: string; text?: string }
  signed?: unknown
  segments?: readonly V2Segment[]
}

/** 跨块合并后的定位片段。 */
export interface V2Segment {
  blockId: string
  seq: number
  start: number
  end: number
}

/** 选择条件。 */
export interface SelectFilter {
  view: string
  roles: readonly string[]
  blockTypes: readonly string[]
  depth?: { unit: 'message' | 'turn' | 'block'; limit: number }
  crossBlock?: boolean
  separator?: string
  includeCurrent?: boolean
}

/** 动作目标。 */
export interface V2Target {
  view: 'model' | 'display'
  role?: string
  anchor?: string
  position?: 'before' | 'after'
  depth?: number
  lifetime?: 'request' | 'turn' | 'session'
}

/** 一条动作声明。 */
export interface V2Action {
  id: string
  kind: V2ActionKind
  enabledDefault: boolean
  stage: string
  cooldownMs: number
  dedupe: { mode: 'occurrence' | 'none' }
  dependsOn: string[]
  failurePolicy?: 'skip-dependents' | 'continue'
  template?: string
  maxChars?: number
  target?: V2Target
  executorRef?: string
  inputs?: unknown
  timeoutMs?: number
  variable?: string
  value?: unknown
  patch?: { kind: 'tool-arguments'; path: string; value: unknown }
}

/** 规范化之后的 v2 规则。 */
export interface NormalizedRuleV2 {
  schemaVersion: 2
  sourceId: string
  id: string
  revision: number
  title?: string
  description?: string
  on: string[]
  select: SelectFilter
  match: ConditionNode
  actions: V2Action[]
  priority: number
  exclusiveGroup?: string
}

/** 一次匹配的证据。 */
export interface MatchEvidence {
  ok: boolean
  ranges: number[][]
  captures: Record<string, unknown>
  field?: string
  matches?: MatchEvidence[]
  facts?: Record<string, unknown>
}

/** 条件求值用的快照。 */
export interface ConditionSnapshot {
  block: V2Block
  facts?: Record<string, unknown>
  [key: string]: unknown
}

/** 一个命中事件。 */
export interface RuleEvent {
  schemaVersion: 2
  occurrenceId: string
  sourceId: string
  ruleId: string
  ruleRevision: number
  sessionId?: string
  stage: string
  view: string
  blockId: string
  sourceSeqs: number[]
  triggerSeq?: number
  coordinate: 'utf16'
  ranges: number[][]
  captures: Record<string, unknown>
  field?: string
  segments?: readonly V2Segment[]
  block: V2Block
  facts: Record<string, unknown>
}

/** 一块文本补丁。 */
export interface BlockPatch {
  blockId: string
  actionId: string
  priority: number
  range: readonly number[]
  text: string
}

/** 一条补丁的处理结果。 */
export interface PatchResult {
  actionId: string
  status: string
  reason?: string
  blockId?: string
  before?: string
  after?: string
}

/** 补丁应用结果。 */
export interface PatchOutput<B> {
  blocks: B[]
  results: PatchResult[]
}

/** detectRulesV2 的入参。 */
export interface DetectInput {
  rules: readonly NormalizedRuleV2[]
  blocks: readonly V2Block[]
  stage: string
  snapshot?: ConditionSnapshot
  freshSeq?: number
  maxMatches?: number
  detectorMatch?: (rule: NormalizedRuleV2, context: ConditionSnapshot) => unknown
}

/** 值比较：深比较，数组按元素、对象按键。 */
function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => equalJson(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  return leftKeys.length === Object.keys(right).length
    && leftKeys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
}

/** 取条件节点要检查的文本。 */
function textValue(node: { field?: string }, snapshot: ConditionSnapshot): string {
  const value = node.field === undefined ? snapshot.block.text : readBinding(snapshot, node.field)
  if (typeof value !== 'string') throw new TypeError('rules-v2: text matcher selected a non-text value')
  return value
}

/** 这处匹配是否触碰了本次新输出。没给 freshSeq 时一律算触碰。 */
function touchesCurrent(block: V2Block, ranges: readonly (readonly number[])[], freshSeq?: number): boolean {
  if (freshSeq === undefined) return true
  if (!block.segments) return block.seq === freshSeq
  const segments = block.segments.filter(segment => segment.seq === freshSeq)
  if (!ranges.length) return segments.length > 0
  return ranges.some(range => segments.some(segment => range[0] === range[1]
    ? range[0] >= segment.start && range[0] <= segment.end
    : range[0] < segment.end && range[1] > segment.start))
}

/** 跑一次正则，优先返回触碰本次输出的那一次。 */
function textMatch(pattern: string, flags: string, text: string, snapshot: ConditionSnapshot,
  freshSeq: number | undefined, field: string): RegExpExecArray | null {
  const regex = new RegExp(pattern, freshSeq === undefined ? flags : flags + 'g')
  let first: RegExpExecArray | undefined
  for (let match; (match = regex.exec(text)) !== null;) {
    first ??= match
    if (freshSeq === undefined || field !== 'block.text'
      || touchesCurrent(snapshot.block, [[match.index, match.index + match[0].length]], freshSeq)) return match
    // Global zero-width scans must advance by a Unicode code point when u is set.
    if (!match[0].length) regex.lastIndex = match.index + (flags.includes('u') && (text.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1)
  }
  return first ?? null
}

/** Pure conditions return captures from the selected match. A fresh seq prefers matches touching that output within a joined history window. */
export function matchConditionV2(node: ConditionNode, snapshot: ConditionSnapshot, freshSeq?: number): MatchEvidence {
  if (node.kind === 'always') return { ok: true, ranges: [], captures: {} }
  if (node.kind === 'all' || node.kind === 'any') {
    const found: MatchEvidence[] = []
    for (const child of node.conditions) {
      const result = matchConditionV2(child, snapshot, freshSeq)
      if (node.kind === 'any' && result.ok && touchesCurrent(snapshot.block, result.ranges, freshSeq)) return result
      if (node.kind === 'all' && !result.ok) return result
      found.push(result)
    }
    if (node.kind === 'any') return found.find(result => result.ok) ?? { ok: false, ranges: [], captures: {} }
    return { ok: true, ranges: found.flatMap(value => value.ranges), captures: Object.assign({}, ...found.map(value => value.captures)) }
  }
  if (node.kind === 'not') return { ok: !matchConditionV2(node.condition, snapshot, freshSeq).ok, ranges: [], captures: {} }
  if (node.kind === 'compare') {
    if (node.op === 'exists') {
      try { readBinding(snapshot, node.field) } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith('rules-v2: missing binding')) return { ok: false, ranges: [], captures: {} }
        throw error
      }
      return { ok: true, ranges: [], captures: {} }
    }
    const actual = readBinding(snapshot, node.field)
    let ok: boolean
    if (node.op === 'eq' || node.op === 'ne') {
      ok = equalJson(actual, node.value)
      if (node.op === 'ne') ok = !ok
    } else if (node.op === 'contains') {
      if (typeof actual === 'string') ok = actual.includes(String(node.value))
      else if (Array.isArray(actual)) ok = actual.some(value => equalJson(value, node.value))
      else throw new TypeError('rules-v2: contains requires string or array')
    } else {
      if (typeof actual !== 'number' || typeof node.value !== 'number') throw new TypeError('rules-v2: ordered comparison requires numbers')
      const bound = node.value
      ok = node.op === 'gt' ? actual > bound : node.op === 'gte' ? actual >= bound : node.op === 'lt' ? actual < bound : actual <= bound
    }
    return { ok, ranges: [], captures: {} }
  }
  if (node.kind === 'detector') {
    // detector 由执行宿主跑（可能是异步、可能在工作线程里），纯条件求值不碰它。
    throw new Error('rules-v2: detector conditions must be evaluated by the execution host, not by matchConditionV2')
  }
  const text = textValue(node, snapshot)
  if (node.kind === 'regex') {
    // Execution hosts must run untrusted native regex matching in an abortable worker.
    const evidence = (match: RegExpExecArray): MatchEvidence => ({
      ok: true,
      ranges: [[match.index, match.index + match[0].length]],
      captures: { ...Object.fromEntries([...match].map((value, index) => [String(index), value === undefined ? null : value])), ...match.groups },
      field: node.field ?? 'block.text',
    })
    if (node.all === true) {
      const regex = new RegExp(node.pattern, node.flags + 'g')
      const matches: MatchEvidence[] = []
      for (let match; (match = regex.exec(text)) !== null;) {
        matches.push(evidence(match))
        if (matches.length > 1000) throw new Error('rules-v2: regex occurrence budget exceeded')
        if (!match[0].length) regex.lastIndex = match.index + (node.flags.includes('u') && (text.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1)
      }
      return matches.length ? { ...matches[0], matches } : { ok: false, ranges: [], captures: {} }
    }
    const match = textMatch(node.pattern, node.flags, text, snapshot, freshSeq, node.field ?? 'block.text')
    return match ? evidence(match) : { ok: false, ranges: [], captures: {} }
  }
  const results = node.values.map(value => {
    // Match the original string so Unicode case folding never changes UTF-16 coordinates.
    const literal = sanitizeRegexMacro(value)
    const pattern = node.wordBoundary === true ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal
    const match = textMatch(pattern, node.caseSensitive === true ? 'u' : 'iu', text, snapshot, freshSeq, node.field ?? 'block.text')
    return match === null ? undefined : [match.index, match.index + match[0].length]
  })
  const any = results.some(value => value !== undefined)
  const all = results.every(value => value !== undefined)
  const ok = node.mode === 'ANY' ? any : node.mode === 'ALL' ? all : node.mode === 'NOT-ANY' ? !any : !all
  return { ok, ranges: results.filter((value): value is number[] => value !== undefined), captures: {}, field: node.field ?? 'block.text' }
}

/** Validate external evidence before any lifecycle phase can replace it or publish an event. */
export function validateDetectorEvidenceV2(detected: unknown, block: V2Block, maxMatches = 1000): MatchEvidence {
  json(detected, 'detector evidence')
  const source = object(detected, 'detector evidence')
  let list: unknown[]
  if (Object.hasOwn(source, 'matches')) {
    keys(source, ['matches'], 'detector evidence')
    if (!isUnknownArray(source.matches) || source.matches.length > maxMatches) throw new Error('rules-v2: invalid detector occurrences')
    list = source.matches
  } else {
    list = [source]
  }
  const parsed: MatchEvidence[] = []
  for (const item of list) {
    const result = object(item, 'detector result')
    boolean(result.ok, 'detector result.ok')
    keys(result, ['ok', 'ranges', 'captures', 'facts', 'field'], 'detector result')
    if (result.field !== undefined && result.field !== 'block.text') throw new Error('rules-v2: detector ranges require block.text')
    if (result.facts !== undefined) object(result.facts, 'detector facts')
    if (!isUnknownArray(result.ranges) || result.ranges.length > 1000) throw new Error('rules-v2: invalid detector ranges')
    const ranges: number[][] = []
    for (const range of result.ranges) {
      if (!isUnknownArray(range) || range.length !== 2) throw new Error('rules-v2: invalid detector range')
      const [start, end] = range
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end > (block.text?.length ?? 0)) throw new Error('rules-v2: invalid detector range')
      ranges.push([start, end])
    }
    const captures = object(result.captures, 'detector captures')
    const facts = result.facts === undefined ? undefined : object(result.facts, 'detector facts')
    const evidence: MatchEvidence = { ok: result.ok === true, ranges, captures }
    if (typeof result.field === 'string') evidence.field = result.field
    if (facts !== undefined) evidence.facts = facts
    parsed.push(evidence)
  }
  if (Object.hasOwn(source, 'matches')) return { ok: parsed.some(value => value.ok), ranges: [], captures: {}, matches: parsed }
  return parsed[0] ?? { ok: false, ranges: [], captures: {} }
}

/** 动作字段白名单：声明不能带执行器会忽略的字段。 */
const FIELDS_BY_KIND: Readonly<Record<V2ActionKind, readonly string[]>> = Object.freeze({
  notify: ['template', 'maxChars', 'target'], guidance: ['template', 'maxChars', 'target'], inject: ['template', 'maxChars', 'target'],
  replace: ['template', 'maxChars', 'patch'], filter: [],
  program: ['executorRef', 'inputs', 'timeoutMs'], tool: ['executorRef', 'inputs', 'timeoutMs'], job: ['executorRef', 'inputs', 'timeoutMs'],
  'set-variable': ['variable', 'value'], abort: [], resume: ['template', 'maxChars'], compact: ['template', 'maxChars', 'timeoutMs'],
})

/** 判定深度单位。 */
function isDepthUnit(value: unknown): value is 'message' | 'turn' | 'block' {
  return value === 'message' || value === 'turn' || value === 'block'
}

/** 判定目标视图。 */
function isTargetView(value: unknown): value is 'model' | 'display' {
  return value === 'model' || value === 'display'
}

/**
 * 规范化 v2 规则：全部字段校验后**重新构造**一个新对象。
 *
 * 不克隆输入再就地改：那样每个字段的类型都停在 unknown，收窄结果无法传给调用方。
 * 构造式还有个副作用是好的 —— 没声明的字段不会被悄悄带进产物。
 */
export function normalizeRuleV2(input: unknown): NormalizedRuleV2 {
  const source = object(input, 'rule')
  json(source, 'rule')
  keys(source, ['schemaVersion', 'sourceId', 'id', 'revision', 'title', 'description', 'on', 'select', 'match', 'actions', 'priority', 'exclusiveGroup'], 'rule')
  if (source.schemaVersion !== 2) throw new TypeError('rules-v2: schemaVersion must be 2')

  const sourceId = id(source.sourceId, 'sourceId')
  const ruleId = id(source.id, 'rule id')
  const revision = integer(source.revision, 1, Number.MAX_SAFE_INTEGER, 'revision')

  const onRaw = source.on
  if (!isUnknownArray(onRaw) || !onRaw.length) throw new TypeError('rules-v2: on stages are required')
  const on = onRaw.map(stage => one(stage, V2_STAGES, 'stage'))

  const selectSource = object(source.select, 'select')
  keys(selectSource, ['view', 'roles', 'blockTypes', 'depth', 'crossBlock', 'separator', 'includeCurrent'], 'select')
  const view = one(selectSource.view, ['original', 'model', 'display'], 'view')
  const rolesRaw = selectSource.roles
  const blockTypesRaw = selectSource.blockTypes
  if (!isUnknownArray(rolesRaw) || !rolesRaw.length) throw new TypeError('rules-v2: select.roles is required')
  if (!isUnknownArray(blockTypesRaw) || !blockTypesRaw.length) throw new TypeError('rules-v2: select.blockTypes is required')
  const roles = rolesRaw.map(role => one(role, ['system', 'developer', 'user', 'assistant', 'tool'], 'role'))
  const blockTypes = blockTypesRaw.map(type => one(type, ['text', 'reasoning', 'tool-call', 'tool-result', 'image', 'file', 'unknown'], 'block type'))
  const select: SelectFilter = { view, roles, blockTypes }
  if (selectSource.depth !== undefined) {
    const depth = object(selectSource.depth, 'depth')
    keys(depth, ['unit', 'limit'], 'depth')
    const unit = depth.unit
    if (!isDepthUnit(unit)) throw new TypeError(`rules-v2: unsupported depth unit: ${String(unit)}`)
    select.depth = { unit, limit: integer(depth.limit, 1, 10000, 'depth limit') }
  }
  if (selectSource.crossBlock !== undefined) select.crossBlock = boolean(selectSource.crossBlock, 'select.crossBlock')
  if (selectSource.includeCurrent !== undefined) select.includeCurrent = boolean(selectSource.includeCurrent, 'select.includeCurrent')
  if (selectSource.separator !== undefined) select.separator = text(selectSource.separator, 4096, 'select.separator')
  if (select.crossBlock === true && typeof select.separator !== 'string') throw new Error('rules-v2: crossBlock requires an explicit separator')

  const match = condition(source.match)
  const priority = integer(source.priority ?? 0, -100000, 100000, 'priority')

  const actionsRaw = source.actions
  if (!isUnknownArray(actionsRaw) || !actionsRaw.length || actionsRaw.length > 64) throw new TypeError('rules-v2: actions are required')
  const actions: V2Action[] = []
  const ids = new Set<string>()
  for (const raw of actionsRaw) {
    const action = object(raw, 'action')
    const actionId = id(action.id, 'action id')
    const kind = one(action.kind, V2_ACTIONS, 'action kind')
    keys(action, ['id', 'kind', 'enabledDefault', 'stage', 'cooldownMs', 'dedupe', 'dependsOn', 'failurePolicy', ...FIELDS_BY_KIND[kind]], `${kind} action`)
    if (ids.has(actionId)) throw new Error('rules-v2: duplicate action id')
    ids.add(actionId)
    if (typeof action.enabledDefault !== 'boolean') throw new TypeError('rules-v2: enabledDefault must be boolean')
    const stage = one(action.stage, on, 'action stage')
    const cooldownMs = integer(action.cooldownMs ?? 0, 0, 86400000, 'cooldownMs')
    const dedupeSource = object(action.dedupe ?? { mode: 'occurrence' }, 'dedupe')
    keys(dedupeSource, ['mode'], 'dedupe')
    const dedupeMode = one(dedupeSource.mode, ['occurrence', 'none'], 'dedupe mode')
    const dependsSource = action.dependsOn ?? []
    if (!isUnknownArray(dependsSource) || dependsSource.length > 64) throw new TypeError('rules-v2: dependsOn must be a bounded array')
    const dependsOn = dependsSource.map(ref => id(ref, 'dependency id'))
    if (new Set(dependsOn).size !== dependsOn.length) throw new TypeError('rules-v2: duplicate dependency')

    const parsed: V2Action = {
      id: actionId, kind, enabledDefault: action.enabledDefault, stage,
      cooldownMs, dedupe: { mode: dedupeMode }, dependsOn,
    }
    if (action.timeoutMs !== undefined) parsed.timeoutMs = integer(action.timeoutMs, 1, 86400000, 'timeoutMs')
    if (action.maxChars !== undefined) parsed.maxChars = integer(action.maxChars, 1, 1048576, 'maxChars')
    if (action.failurePolicy !== undefined) parsed.failurePolicy = one(action.failurePolicy, ['skip-dependents', 'continue'], 'failurePolicy')
    if (kind === 'program' || kind === 'tool' || kind === 'job') parsed.executorRef = id(action.executorRef, 'executorRef')
    const needsTemplate = kind === 'notify' || kind === 'guidance' || kind === 'inject' || kind === 'resume' || kind === 'compact'
      || (kind === 'replace' && action.patch === undefined)
    if (needsTemplate && typeof action.template !== 'string') throw new TypeError('rules-v2: template is required')
    if (action.template !== undefined) parsed.template = text(action.template, 16384, 'template')
    if (action.inputs !== undefined) { bindings(action.inputs, 'inputs'); parsed.inputs = structuredClone(action.inputs) }
    if (kind === 'set-variable') {
      parsed.variable = id(action.variable, 'variable')
      if (!Object.hasOwn(action, 'value')) throw new TypeError('rules-v2: variable value is required')
      bindings(action.value, 'variable value')
      parsed.value = structuredClone(action.value)
    }
    if (action.patch !== undefined) {
      if (kind !== 'replace') throw new TypeError('rules-v2: patch requires replace action')
      const patch = object(action.patch, 'patch')
      keys(patch, ['kind', 'path', 'value'], 'patch')
      const patchKind = one(patch.kind, ['tool-arguments'], 'patch kind')
      if (typeof patch.path !== 'string' || !patch.path.startsWith('/')) throw new TypeError('rules-v2: patch requires JSON Pointer')
      const patchPath = path(patch.path, 'patch path')
      if (!Object.hasOwn(patch, 'value')) throw new TypeError('rules-v2: patch value is required')
      bindings(patch.value, 'patch value')
      parsed.patch = { kind: patchKind, path: patchPath, value: structuredClone(patch.value) }
    }
    if (action.target !== undefined) {
      const target = object(action.target, 'target')
      keys(target, ['view', 'role', 'anchor', 'position', 'depth', 'lifetime'], 'target')
      const targetView = target.view
      if (!isTargetView(targetView)) throw new TypeError(`rules-v2: unsupported target view: ${String(targetView)}`)
      const parsedTarget: V2Target = { view: targetView }
      if (target.role !== undefined) parsedTarget.role = one(target.role, ['system', 'developer', 'user', 'assistant', 'tool'], 'target role')
      if (target.position !== undefined) parsedTarget.position = one(target.position, ['before', 'after'], 'position')
      if (target.anchor !== undefined) parsedTarget.anchor = id(target.anchor, 'target anchor')
      if (target.depth !== undefined) parsedTarget.depth = integer(target.depth, 0, 10000, 'target depth')
      if (target.anchor === 'depth' && target.depth === undefined) throw new TypeError('rules-v2: depth anchor requires depth')
      if (target.depth !== undefined && target.anchor !== 'depth') throw new TypeError('rules-v2: depth requires depth anchor')
      if (target.lifetime !== undefined) parsedTarget.lifetime = one(target.lifetime, ['request', 'turn', 'session'], 'target lifetime')
      if (parsedTarget.role === 'tool') throw new TypeError('rules-v2: tool injection requires a real result')
      if ((kind === 'notify' || kind === 'guidance') && Object.keys(target).some(key => key !== 'view' && key !== 'lifetime')) {
        throw new TypeError('rules-v2: notice target only supports view and lifetime')
      }
      const wantView = stage === 'display.render' ? 'display' : 'model'
      if (parsedTarget.view !== wantView) throw new TypeError('rules-v2: target view does not match action stage')
      parsed.target = parsedTarget
    }
    if (kind === 'replace' && parsed.patch !== undefined && parsed.template !== undefined) throw new TypeError('rules-v2: argument patch cannot also replace text')
    if (stage === 'output.delta' && (kind === 'program' || kind === 'tool' || kind === 'job' || kind === 'replace' || kind === 'filter' || kind === 'set-variable' || kind === 'compact')) {
      throw new TypeError('rules-v2: action requires a complete block')
    }
    if (stage === 'display.render' && kind !== 'inject' && kind !== 'replace' && kind !== 'filter') throw new TypeError('rules-v2: display actions must be pure')
    actions.push(parsed)
  }

  // 依赖必须指向同一 stage 的动作，且不能成环。
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (action: V2Action): void => {
    if (visiting.has(action.id)) throw new Error('rules-v2: cyclic action dependency')
    if (visited.has(action.id)) return
    visiting.add(action.id)
    for (const ref of action.dependsOn) {
      const parent = actions.find(value => value.id === ref)
      if (parent === undefined) throw new Error(`rules-v2: missing dependency ${ref}`)
      if (parent.stage !== action.stage) throw new Error('rules-v2: dependency must use the same stage')
      visit(parent)
    }
    visiting.delete(action.id)
    visited.add(action.id)
  }
  actions.forEach(visit)
  for (const action of actions.filter(value => value.kind === 'resume')) {
    const hasAbort = action.dependsOn.some(ref => actions.find(parent => parent.id === ref)?.kind === 'abort')
    if (action.failurePolicy === 'continue' || !hasAbort) {
      throw new Error('rules-v2: resume requires a successful same-stage abort dependency')
    }
  }

  const rule: NormalizedRuleV2 = { schemaVersion: 2, sourceId, id: ruleId, revision, on, select, match, actions, priority }
  if (source.title !== undefined) rule.title = text(source.title, 4096, 'title')
  if (source.description !== undefined) rule.description = text(source.description, 16384, 'description')
  if (source.exclusiveGroup !== undefined) rule.exclusiveGroup = id(source.exclusiveGroup, 'exclusiveGroup')
  return rule
}

/** Depth windows count messages/turns before role/type selection; nested blocks share their parent's identity. */
export function selectBlocksV2<B extends V2Block>(blocks: readonly B[], select: SelectFilter): B[] {
  let window: readonly B[] = blocks
  if (select.depth !== undefined) {
    const unit = select.depth.unit
    const key = (block: B): string | number | undefined => unit === 'block' ? block.id : unit === 'message' ? block.messageId : block.turnId
    if (blocks.some(block => key(block) === undefined)) throw new Error(`rules-v2: ${unit} identity unavailable`)
    const units = [...new Set(blocks.map(key))]
    const admitted = new Set(units.slice(-select.depth.limit))
    window = blocks.filter(block => admitted.has(key(block)))
  }
  return window.filter(block => block.view === select.view && select.roles.includes(block.role) && select.blockTypes.includes(block.type))
}

/** One event per selected block, shared by every action. freshSeq restricts triggers before exclusive groups are claimed; sourceSeqs retain the complete inspected window. */
export function detectRulesV2({ rules, blocks, stage, snapshot, freshSeq, maxMatches = 1000, detectorMatch }: DetectInput): RuleEvent[] {
  if (freshSeq !== undefined) integer(freshSeq, 0, Number.MAX_SAFE_INTEGER, 'freshSeq')
  const base: ConditionSnapshot = snapshot ?? { block: blocks[0] ?? { id: '', view: '', role: '', type: '', seq: 0 } }
  const events: RuleEvent[] = []
  const exclusive = new Set<string>()
  const sorted = [...rules].sort((a, b) => b.priority - a.priority || a.sourceId.localeCompare(b.sourceId) || a.id.localeCompare(b.id))
  for (const rule of sorted) {
    if (!rule.on.includes(stage)) continue
    if (rule.exclusiveGroup !== undefined && exclusive.has(rule.exclusiveGroup)) continue
    let selected = selectBlocksV2(blocks, rule.select)
    if (rule.select.includeCurrent === false) selected = selected.filter(block => block.seq !== base.currentSeq)
    if (rule.select.crossBlock === true && selected.length) {
      if (selected.some(block => typeof block.text !== 'string')) throw new Error('rules-v2: crossBlock requires textual blocks')
      const separator = rule.select.separator ?? ''
      let offset = 0
      const segments: V2Segment[] = selected.map((block, index) => {
        const start = offset
        const body = block.text ?? ''
        offset += body.length + (index < selected.length - 1 ? separator.length : 0)
        return { blockId: block.id, seq: block.seq, start, end: start + body.length }
      })
      const first = selected[0]
      selected = [{ ...first, id: JSON.stringify(selected.map(block => block.id)), text: selected.map(block => block.text ?? '').join(separator), segments }]
    }
    let matched = false
    for (const block of selected) {
      const context: ConditionSnapshot = { ...base, stage, block, tool: { name: block.raw?.name, arguments: block.arguments, result: block.raw?.content } }
      let detected: MatchEvidence
      if (rule.match.kind === 'detector') {
        if (detectorMatch === undefined) throw new Error(`rules-v2: detector unavailable:${rule.match.ref}`)
        detected = validateDetectorEvidenceV2(detectorMatch(rule, context), block, maxMatches)
      } else {
        detected = matchConditionV2(rule.match, context, freshSeq)
      }
      for (const result of detected.matches ?? [detected]) {
        if (!result.ok || !touchesCurrent(block, result.ranges, freshSeq)) continue
        matched = true
        const parts: (V2Segment | V2Block)[] = block.segments === undefined ? [block] : [...block.segments]
        const sourceSeqs = [...new Set(parts.map(part => {
          if (typeof part.seq === 'number' && Number.isSafeInteger(part.seq)) return part.seq
          const blockId = 'blockId' in part ? part.blockId : undefined
          return blockId === undefined ? undefined : blocks.find(candidate => candidate.id === blockId)?.seq
        }).filter((seq): seq is number => typeof seq === 'number' && Number.isSafeInteger(seq)))]
        const event: RuleEvent = {
          schemaVersion: 2,
          occurrenceId: JSON.stringify([rule.sourceId, rule.id, rule.revision, stage, block.id, result.ranges]),
          sourceId: rule.sourceId, ruleId: rule.id, ruleRevision: rule.revision,
          stage, view: block.view, blockId: block.id, sourceSeqs, coordinate: 'utf16',
          ranges: result.ranges, captures: result.captures,
          block, facts: structuredClone(result.facts ?? base.facts ?? {}),
        }
        if (block.sessionId !== undefined) event.sessionId = block.sessionId
        if (freshSeq !== undefined) event.triggerSeq = freshSeq
        const field = result.field ?? (rule.match.kind === 'detector' ? 'block.text' : undefined)
        if (field !== undefined) event.field = field
        if (block.segments !== undefined) event.segments = block.segments
        events.push(event)
        if (events.length > maxMatches) throw new Error('rules-v2: match budget exceeded')
      }
    }
    if (matched && rule.exclusiveGroup !== undefined) exclusive.add(rule.exclusiveGroup)
  }
  return events
}

/** 可被补丁写入的块。 */
export interface PatchableBlock {
  id: string
  text?: string
  raw?: { text?: string; [key: string]: unknown }
  signed?: unknown
  segments?: unknown
}

/** Immutable text patches resolve overlaps by explicit priority; signed/opaque and cross-block writes are rejected. */
export function applyBlockPatchesV2<B extends PatchableBlock>(blocks: readonly B[], patches: readonly BlockPatch[]): PatchOutput<B> {
  const changes = new Map<string, BlockPatch[]>()
  const results: PatchResult[] = []
  const sorted = [...patches].sort((a, b) => b.priority - a.priority || a.actionId.localeCompare(b.actionId))
  for (const patch of sorted) {
    const block = blocks.find(value => value.id === patch.blockId)
    if (block === undefined) throw new Error('rules-v2: stale block anchor')
    if (block.signed !== undefined || typeof block.text !== 'string') throw new Error('rules-v2: block cannot be text-patched')
    if (block.segments !== undefined) throw new Error('rules-v2: cross-block replacement requires per-block patches')
    const start = patch.range[0]
    const end = patch.range[1]
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > block.text.length) throw new Error('rules-v2: invalid patch range')
    if (typeof patch.text !== 'string') throw new TypeError('rules-v2: replacement must be text')
    const accepted = changes.get(block.id) ?? []
    if (accepted.some(old => start < old.range[1] && end > old.range[0])) {
      results.push({ actionId: patch.actionId, status: 'skipped', reason: 'overlapping-patch' })
      continue
    }
    accepted.push(patch)
    changes.set(block.id, accepted)
    results.push({ actionId: patch.actionId, status: 'planned', blockId: block.id, before: block.text.slice(start, end), after: patch.text })
  }
  const transformed = blocks.map(block => {
    const accepted = changes.get(block.id)
    if (accepted === undefined) return block
    let text = block.text ?? ''
    for (const patch of [...accepted].sort((a, b) => b.range[0] - a.range[0])) {
      text = text.slice(0, patch.range[0]) + patch.text + text.slice(patch.range[1])
    }
    return { ...block, text, raw: { ...block.raw, text } }
  })
  return { blocks: transformed, results }
}
