import { indexBlockSurfaces } from './block-surface.js'
import { sanitizeRegexMacro } from './regex.js'
import { matchFactCondition } from './condition-facts.js'
import { z } from 'zod'
import { InputRecord, OwnedJson, BoundJson, pathParts, parseInput } from './input-schema.js'
import { isRecord, isUnknownArray } from './guard.js'
export { applyBlockPatches as applyBlockPatchesV2 } from './display-patch-plan.js'
import type { NormalizedRule } from './types.js'
import type { StageFields, StageFieldsSchema } from './stage-schema.js'
import { normalizeRule, compareRules } from './rules.js'
import { measureCondition } from './count-condition.js'
import { TextSamples, type TextSampleValue } from './count-condition.js'
import type { TextCountResult, MatchTruth } from './text-count.js'
import { DeliveryPolicy } from './event-policy.js'

import { V2_STAGES, V2_ACTIONS } from './stage-schema.js'
export { V2_STAGES, V2_ACTIONS } from './stage-schema.js'

/** 一个 v2 触发阶段。 */
export type V2Stage = (typeof V2_STAGES)[number]
/** 一种 v2 动作类型。 */
export type V2ActionKind = (typeof V2_ACTIONS)[number]

const forbidden = new Set(['__proto__', 'prototype', 'constructor'])

/** Read own properties only. Missing paths are errors, not invented empty values. */
export function readBinding(root: unknown, path: string): unknown {
  if (typeof path !== 'string' || path.length > 1024) throw new TypeError('rules-v2: invalid binding path')
  const parts = pathParts(path)
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
  return bound(parseInput(BoundJson, input, 'inputs'), snapshot)
}
/** 递归求值绑定。 */
function bound(input: unknown, snapshot: unknown): unknown {
  if (Array.isArray(input)) return input.map(value => bound(value, snapshot))
  if (isRecord(input)) {
    if (Object.hasOwn(input, 'bind')) {
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

export { normalizeCondition } from './condition-schema.js'
import type { ConditionNode } from './condition-schema.js'
export type { ConditionNode } from './condition-schema.js'

/** 一个可被规则选中的块。 */
export interface V2Block {
  id: string
  view: string
  role: string
  type: string
  seq?: number
  text?: string
  messageId?: string
  turnId?: string
  sessionId?: string
  arguments?: unknown
  raw?: { name?: string; content?: string; text?: string }
  surface?: { placement?: string; depth?: number; isEdit?: boolean; isMarkdown?: boolean; isPrompt?: boolean }
  signed?: unknown
  detectorPhase?: unknown
  blockKey?: unknown
  segments?: readonly V2Segment[]
}

/** 跨块合并后的定位片段。 */
export interface V2Segment {
  blockId: string
  seq?: number
  start: number
  end: number
}

/** 公开兼容视图由阶段 schema 派生，字段不在这里重复定义。 */
export type { SelectFilter, V2Target, V2Action } from './stage-schema.js'
import type { SelectFilter, V2Action } from './stage-schema.js'

/** 声明输入的默认项由 normalizeRule 填充，输出仍是完整的统一规则。 */
export type ActionDeclaration = Omit<V2Action, 'cooldownMs' | 'dedupe' | 'dependsOn' | 'delivery'> & Partial<Pick<V2Action, 'cooldownMs' | 'dedupe' | 'dependsOn'>> & { delivery?: import('zod').input<typeof DeliveryPolicy> }
/** 插件声明在编译前保留版本引用；运行产物仍只包含经过校验的核心节点。 */
export interface ConditionExtensionDeclaration { kind: 'extension'; ref: string; revision: number; params?: unknown }
export type ConditionDeclaration = Exclude<ConditionNode, { kind: 'all' | 'any' | 'not' }> | ConditionExtensionDeclaration
  | { kind: 'all' | 'any'; conditions: ConditionDeclaration[] } | { kind: 'not'; condition: ConditionDeclaration }
export interface ActionExtensionDeclaration extends Partial<Pick<V2Action, 'cooldownMs' | 'dedupe' | 'dependsOn' | 'failurePolicy'>> {
  id: string; kind: 'extension'; ref: string; revision: number; params?: unknown; stage: string; enabledDefault: boolean
}
export type RuleDeclaration = Omit<z.input<typeof StageFieldsSchema>, 'on' | 'select' | 'match' | 'actions'> & {
  on: string[]
  select: SelectFilter
  match: ConditionDeclaration
  actions: (ActionDeclaration | ActionExtensionDeclaration)[]
}

/** 同一规则产物的阶段字段已就绪视图，无第二份字段定义。 */
export type NormalizedRuleV2 = NormalizedRule & StageFields

/** 一次匹配的证据。 */
export interface MatchEvidence {
  ok: boolean
  ranges: number[][]
  captures: Record<string, unknown>
  field?: string
  matches?: MatchEvidence[]
  facts?: Record<string, unknown>
  status?: MatchTruth
  measurements?: { path: string; field: string; sampleId?: string; result: TextCountResult }[]
  diagnostics?: { path: string; message: string }[]
}
export interface ConditionEvaluationOptions {
  samples?: readonly TextSampleValue[]
  captureErrors?: boolean
  /** 接收范围中缺失身份不能满足 ne，调用端选择这个叶语义。 */
  missingComparison?: 'unmatched'
  path?: string
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

/** detectRulesV2 的入参。 */
export interface DetectInput {
  rules: readonly NormalizedRuleV2[]
  blocks: readonly V2Block[]
  stage: string
  snapshot?: Record<string, unknown>
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
function textValue(node: { field?: string }, snapshot: Record<string, unknown>): string {
  const value = node.field === undefined ? (isRecord(snapshot.block) ? snapshot.block.text : undefined) : readBinding(snapshot, node.field)
  if (typeof value !== 'string') throw new TypeError('rules-v2: text matcher selected a non-text value')
  return value
}

/** 这处匹配是否触碰了本次新输出。没给 freshSeq 时一律算触碰。 */
function touchesCurrent(block: unknown, ranges: readonly (readonly number[])[], freshSeq?: number): boolean {
  if (freshSeq === undefined) return true
  if (!isRecord(block)) throw new Error('rules-v2: block unavailable for fresh sequence')
  if (!block.segments) return block.seq === freshSeq
  if (!Array.isArray(block.segments)) throw new Error('rules-v2: invalid block segments')
  const segments = block.segments.filter((segment: unknown): segment is V2Segment => isRecord(segment) && typeof segment.blockId === 'string'
    && segment.seq === freshSeq && typeof segment.start === 'number' && typeof segment.end === 'number')
  if (!ranges.length) return segments.length > 0
  return ranges.some(range => segments.some(segment => range[0] === range[1]
    ? range[0] >= segment.start && range[0] <= segment.end
    : range[0] < segment.end && range[1] > segment.start))
}

/** 跑一次正则，优先返回触碰本次输出的那一次。 */
function textMatch(pattern: string, flags: string, text: string, snapshot: Record<string, unknown>,
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
export function matchConditionV2(node: ConditionNode, snapshot: Record<string, unknown>, freshSeq?: number, options: ConditionEvaluationOptions = {}): MatchEvidence {
  const location = options.path ?? 'condition'
  if (node.kind === 'always') return { ok: true, ranges: [], captures: {} }
  if (node.kind === 'all' || node.kind === 'any') {
    const found: MatchEvidence[] = [], measurements: NonNullable<MatchEvidence['measurements']> = [], diagnostics: NonNullable<MatchEvidence['diagnostics']> = []
    const decorated = (result: MatchEvidence): MatchEvidence => measurements.length || diagnostics.length
      ? { ...result, measurements: [...measurements], diagnostics: [...diagnostics] } : result
    for (const [index, child] of node.conditions.entries()) {
      const result = matchConditionV2(child, snapshot, freshSeq, { ...options, path: `${location}.${index}` })
      measurements.push(...result.measurements ?? []); diagnostics.push(...result.diagnostics ?? [])
      if (node.kind === 'any' && result.ok && touchesCurrent(snapshot.block, result.ranges, freshSeq)) return decorated(result)
      if (node.kind === 'all' && !result.ok && result.status !== 'unavailable') return decorated(result)
      found.push(result)
    }
    if (node.kind === 'any') {
      const matched = found.find(result => result.ok)
      if (matched) return decorated(matched)
    }
    if (found.some(result => result.status === 'unavailable')) return decorated({ ok: false, status: 'unavailable', ranges: [], captures: {} })
    return decorated({ ok: node.kind === 'all', ranges: found.flatMap(value => value.ranges), captures: Object.assign({}, ...found.map(value => value.captures)) })
  }
  if (node.kind === 'not') {
    const result = matchConditionV2(node.condition, snapshot, freshSeq, { ...options, path: `${location}.not` })
    return { ok: result.status === 'unavailable' ? false : !result.ok, ...(result.status === 'unavailable' ? { status: result.status } : {}), ranges: [], captures: {},
      ...(result.measurements ? { measurements: result.measurements } : {}), ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) }
  }
  if (node.kind === 'count') {
    const samples = options.samples ?? TextSamples.parse(snapshot.textSamples ?? [])
    const sample = samples.find(value => value.field === node.source.field && value.window === node.window.kind)
    let text: unknown
    try { text = readBinding(snapshot, node.source.field) } catch { text = undefined }
    const measured = measureCondition(node, text, sample)
    return { ok: measured.status === 'matched', status: measured.status, ranges: [], captures: {},
      measurements: [{ path: location, field: node.source.field, ...(sample ? { sampleId: sample.sampleId } : {}), result: measured }] }
  }
  if (options.captureErrors) {
    try { return matchConditionV2(node, snapshot, freshSeq) }
    catch (error) { return { ok: false, status: 'unavailable', ranges: [], captures: {}, diagnostics: [{ path: location, message: error instanceof Error ? error.message : String(error) }] } }
  }
  if (node.kind === 'glob' || node.kind === 'arguments' || node.kind === 'idle' || node.kind === 'numbers' || node.kind === 'text' || node.kind === 'surface') {
    return { ok: matchFactCondition(node, snapshot, field => readBinding(snapshot, field)), ranges: [], captures: {} }
  }
  if (node.kind === 'compare') {
    if (options.missingComparison === 'unmatched') {
      try { if (readBinding(snapshot, node.field) === undefined) return { ok: false, ranges: [], captures: {} } }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('rules-v2: missing binding')) return { ok: false, ranges: [], captures: {} }
        throw error
      }
    }
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

/** 外部证据使用同一 schema 基础设施；范围上界属于本次块的事实。 */
export function validateDetectorEvidenceV2(detected: unknown, block: V2Block, maxMatches = 1000): MatchEvidence {
  parseInput(OwnedJson, detected, 'detector evidence')
  const Range = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .refine(([start, end]) => end >= start && end <= (block.text?.length ?? 0), 'invalid detector range')
  const Evidence = z.object({ ok: z.boolean(), ranges: z.array(Range).max(1000), captures: InputRecord,
    facts: InputRecord.optional(), field: z.literal('block.text').optional() }).strict()
  const parsed = parseInput(z.union([Evidence, z.object({ matches: z.array(Evidence).max(maxMatches) }).strict()]), detected, 'detector evidence')
  return 'matches' in parsed ? { ok: parsed.matches.some(value => value.ok), ranges: [], captures: {}, matches: parsed.matches } : parsed
}

export { normalizeStageFields } from './stage-schema.js'
export type { StageFields } from './stage-schema.js'

export function hasStageRules(rule: NormalizedRule): rule is NormalizedRuleV2 {
  return rule.schemaVersion === 2 && rule.sourceId !== undefined && rule.revision !== undefined && rule.on !== undefined
    && rule.select !== undefined && rule.match !== undefined && rule.actions !== undefined && rule.priority !== undefined
}
/** 阶段入口使用与单动作规则相同的规范化产物。 */
export function normalizeRuleV2(input: unknown): NormalizedRuleV2 {
  // 旧阶段入口仍报告它的字段路径；规范化本身统一经过 normalizeRule。
  const rule = normalizeRule(input, 0)
  if (!hasStageRules(rule)) throw new TypeError('dsh-rule-engine: stage rule fields are required')
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
  if (freshSeq !== undefined) parseInput(z.number().int().nonnegative(), freshSeq, 'freshSeq')
  const base: Record<string, unknown> = snapshot ?? {}
  const blockSurface = indexBlockSurfaces(blocks)
  const events: RuleEvent[] = []
  const exclusive = new Set<string>()
  const sorted = [...rules].sort(compareRules)
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
    for (const original of selected) {
      const block = { ...original, surface: blockSurface(original) }
      const context: ConditionSnapshot = { ...base, stage, block, surface: block.surface, tool: { name: block.raw?.name, arguments: block.arguments, result: block.raw?.content } }
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
        const facts = result.facts ?? base.facts ?? {}
        if (!isRecord(facts)) throw new TypeError('rules-v2: facts must be an object')
        const event: RuleEvent = {
          schemaVersion: 2,
          occurrenceId: JSON.stringify([rule.sourceId, rule.id, rule.revision, stage, block.id, result.ranges]),
          sourceId: rule.sourceId, ruleId: rule.id, ruleRevision: rule.revision,
          stage, view: block.view, blockId: block.id, sourceSeqs, coordinate: 'utf16',
          ranges: result.ranges, captures: result.captures,
          block, facts: structuredClone(facts),
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
