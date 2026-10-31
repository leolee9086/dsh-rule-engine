import { V2_STAGES, detectRulesV2, type BlockedGroup, type NormalizedRuleV2, type RuleEvent, type RuleOrderKey, type V2Block } from './block-rules.js'
import { compareRuleOrderKey, compareRules, ruleOrderKey } from './rules.js'
import { detectorCode, detectorHostCallback, detectorValidator, assertDetectorJson, type DetectorSpecification, type DetectorStates, type DetectorHeldState } from './detector-protocol.js'
import { builtinDetectorSpecifications } from './builtin-detectors.js'
import { createHostDetectors } from './detector-host.js'
import { isRecord } from './guard.js'

const bounded = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
export interface DetectionInput { rules: readonly NormalizedRuleV2[]; blocks: readonly V2Block[]; stage: string; [key: string]: unknown }
export interface DetectionOptions { sessionId?: string; scope?: string; epoch?: unknown; current?(): boolean }
export interface DetectionMatcher { detect(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }
interface ScopeState { states: DetectorStates; specifications: DetectorSpecification[]; epoch?: unknown; sessionId?: string; busy: boolean }
interface ActiveRun { controller: AbortController; specifications: DetectorSpecification[]; scope?: string; done?: Promise<RuleEvent[]> }
function heldState(value: unknown): value is DetectorHeldState {
  return isRecord(value) && Object.hasOwn(value, 'state') && typeof value.offset === 'number' && Object.hasOwn(value, 'params')
}
function outputOf(value: unknown): { events: RuleEvent[]; states: Record<string, DetectorHeldState | null> } {
  if (!isRecord(value) || !Array.isArray(value.events) || !isRecord(value.states)) throw new Error('detector-worker-output-invalid')
  const events: RuleEvent[] = []
  for (const event of value.events) {
    if (!isRecord(event) || typeof event.sourceId !== 'string' || typeof event.ruleId !== 'string' || typeof event.ruleRevision !== 'number'
      || typeof event.stage !== 'string' || typeof event.occurrenceId !== 'string' || !Array.isArray(event.sourceSeqs) || !event.sourceSeqs.every((seq: unknown) => typeof seq === 'number')
      || !isRecord(event.block) || typeof event.block.id !== 'string' || typeof event.block.view !== 'string' || typeof event.block.role !== 'string' || typeof event.block.type !== 'string'
       || event.block.seq !== undefined && typeof event.block.seq !== 'number'
      || !Array.isArray(event.ranges) || !event.ranges.every((range: unknown) => Array.isArray(range) && range.every((point: unknown) => typeof point === 'number'))
      || !isRecord(event.captures)) throw new Error('detector-worker-event-invalid')
    const block: V2Block = { ...event.block, id: event.block.id, view: event.block.view, role: event.block.role, type: event.block.type }
    if (typeof event.block.text === 'string') block.text = event.block.text
    if (typeof event.block.seq === 'number') block.seq = event.block.seq
    const sourceSeqs = event.sourceSeqs.filter((seq: unknown): seq is number => typeof seq === 'number')
    const ranges: number[][] = event.ranges.map((range: unknown) => Array.isArray(range) ? range.filter((point: unknown): point is number => typeof point === 'number') : [])
    events.push({ ...event, schemaVersion: 2, view: typeof event.view === 'string' ? event.view : block.view, blockId: typeof event.blockId === 'string' ? event.blockId : block.id, coordinate: 'utf16', sourceId: event.sourceId, ruleId: event.ruleId, ruleRevision: event.ruleRevision, stage: event.stage, occurrenceId: event.occurrenceId, sourceSeqs, block, ranges, captures: event.captures,
      ...(typeof event.triggerSeq === 'number' ? { triggerSeq: event.triggerSeq } : {}), ...(typeof event.field === 'string' ? { field: event.field } : {}), facts: isRecord(event.facts) ? event.facts : {} })
  }
  const states: Record<string, DetectorHeldState | null> = {}
  for (const [key, state] of Object.entries(value.states)) { if (state !== null && !heldState(state)) throw new Error('detector-worker-state-invalid'); states[key] = state }
  return { events, states }
}
async function releaseAll(releases: readonly (() => unknown | Promise<unknown>)[], primary?: unknown): Promise<void> {
  const errors: unknown[] = []
  for (const release of releases) { try { await release() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors], 'context-care-resource-close-failed')
}
/** 合并一次检测后的状态：null 表示这条流已经收尾。 */
function mergeStates(previous: DetectorStates, updated: Record<string, DetectorHeldState | null>): DetectorStates {
  const states = { ...previous }
  for (const [key, value] of Object.entries(updated)) { if (value === null) delete states[key]; else states[key] = value }
  return states
}
/** 规则在全局顺序里的身份：v2 的 sourceId + id，和 sortUniqueRules 的去重口径一致。 */
const ruleKey = (rule: { sourceId?: string; id: string }): string => JSON.stringify([rule.sourceId ?? null, rule.id])
/**
 * 两条通路合流：独占组仍按同一份全局顺序决出唯一的赢家。
 *
 * 两条通路各自排序、各自跑，所以同一个独占组可能两边都出了结果。这里按 compareRules
 * 的顺序取最靠前的那条规则，落败一方的事件丢弃。不能只按数组顺序拼接，否则低优先级的
 * 宿主规则会盖掉高优先级的 Worker 规则。
 *
 * 注意落败一方的回调已经执行过，它自己的状态记账不回滚——这是两条通路分开执行的代价，
 * 不会影响本趟输出的取舍。
 */
function mergeEvents(local: readonly RuleEvent[], remote: readonly RuleEvent[], rules: readonly NormalizedRuleV2[]): RuleEvent[] {
  const sorted = [...rules].sort(compareRules)
  const rank = new Map(sorted.map((rule, index) => [ruleKey(rule), index]))
  const groups = new Map<string, string>()
  for (const rule of sorted) if (rule.exclusiveGroup !== undefined) groups.set(ruleKey(rule), rule.exclusiveGroup)
  const place = (event: RuleEvent) => rank.get(ruleKey({ sourceId: event.sourceId, id: event.ruleId })) ?? Number.MAX_SAFE_INTEGER
  const events = [...local, ...remote], claimed = new Map<string, number>()
  for (const event of events) {
    const group = groups.get(ruleKey({ sourceId: event.sourceId, id: event.ruleId }))
    if (group === undefined) continue
    const position = place(event)
    const previous = claimed.get(group)
    if (previous === undefined || position < previous) claimed.set(group, position)
  }
  return events.filter(event => {
    const group = groups.get(ruleKey({ sourceId: event.sourceId, id: event.ruleId }))
    return group === undefined || place(event) === claimed.get(group)
  }).sort((left, right) => place(left) - place(right) || left.occurrenceId.localeCompare(right.occurrenceId))
}
/** 宿主通路已经决出的独占组，只带决出者的排序键。 */
function claimedGroups(events: readonly RuleEvent[], rules: readonly NormalizedRuleV2[]): BlockedGroup[] {
  const claimed = new Map<string, RuleOrderKey>()
  for (const event of events) {
    const rule = rules.find(item => item.id === event.ruleId && item.sourceId === event.sourceId)
    if (rule?.exclusiveGroup === undefined) continue
    const order = ruleOrderKey(rule), previous = claimed.get(rule.exclusiveGroup)
    if (previous === undefined || compareRuleOrderKey(order, previous) < 0) claimed.set(rule.exclusiveGroup, order)
  }
  return [...claimed].map(([group, after]) => ({ group, after }))
}
/** 检测器注册、临时状态、策略代次和 Worker 收尾统一属于引擎。 */
export function createDetectorRegistry(matcher: DetectionMatcher, { maxScopes = 128, maxStateBytes = 4194304 } = {}) {
  const registrations = new Map<string, DetectorSpecification>(), scopes = new Map<string, ScopeState>(), active = new Set<ActiveRun>()
  const hostStates = new Map<string, DetectorStates>()
  const feeds = new Map<string, { cancelled: boolean; done?: Promise<RuleEvent[]> }>(), resets = new Map<string, Promise<unknown>>()
  let generation = 0, closed = false
  const overlaps = (a?: string, b?: string) => !a || !b || a === b
  const lookup = (ref: string, sessionId?: string) => [...registrations.values()].find(spec => spec.ref === ref && (!spec.sessionId || spec.sessionId === sessionId))
  const register = (input: unknown, internal = false) => {
    if (closed) throw new Error('detector-registry-closed')
    if (registrations.size >= 128) throw new Error('detector-registration-budget-exceeded')
    if (!isRecord(input) || Object.keys(input).some(key => !['plugin', 'ref', 'revision', 'sessionId', 'on', 'paramsSchema', 'stateSchema', 'resultSchema', 'timeoutMs', 'maxStateBytes', 'maxResultBytes', 'hostCallbacks', 'workerCallbacks', ...(internal ? ['builtin'] : [])].includes(key))) throw new Error('detector-invalid-registration-field')
    const { plugin, ref, revision, sessionId, on, paramsSchema, stateSchema, resultSchema, timeoutMs = 50, maxStateBytes = 262144, maxResultBytes = 65536 } = input
    if (typeof plugin !== 'string' || !plugin || plugin.length > 256 || typeof ref !== 'string' || !ref || ref.length > 256
      || sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId) || !bounded(revision, 1, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(on) || !on.length || !on.every((stage: unknown): stage is string => typeof stage === 'string' && V2_STAGES.some(value => value === stage))) throw new Error('detector-invalid-registration')
    if (!bounded(timeoutMs, 1, 100) || !bounded(maxStateBytes, 1, 1048576) || !bounded(maxResultBytes, 1, 1048576)) throw new Error('detector-invalid-budget')
    if ([...registrations.values()].some(spec => spec.ref === ref && overlaps(spec.sessionId, sessionId))) throw new Error('detector-registration-conflict')
    for (const schema of [paramsSchema, stateSchema, resultSchema]) detectorValidator(schema)
    if (input.builtin && !internal) throw new Error('detector-builtin-reserved')
    // 两条通路互斥：宿主给函数（本进程直调），Worker 给源码（另一侧编译）。
    const hasHost = input.hostCallbacks !== undefined, hasWorker = input.workerCallbacks !== undefined
    if (!input.builtin && hasHost === hasWorker) throw new Error('detector-callbacks-path-required')
    let hostCallbacks: DetectorSpecification['hostCallbacks']
    let workerCallbacks: DetectorSpecification['workerCallbacks']
    if (hasHost) {
      const raw = isRecord(input.hostCallbacks) ? input.hostCallbacks : {}
      hostCallbacks = {
        initialize: detectorHostCallback(raw.initialize, 'initialize'), feed: detectorHostCallback(raw.feed, 'feed'),
        finalize: detectorHostCallback(raw.finalize, 'finalize'), reset: detectorHostCallback(raw.reset, 'reset'),
      }
    }
    if (hasWorker) {
      const raw = isRecord(input.workerCallbacks) ? input.workerCallbacks : {}
      workerCallbacks = {
        initialize: detectorCode(raw.initialize, 'initialize'), feed: detectorCode(raw.feed, 'feed'),
        finalize: detectorCode(raw.finalize, 'finalize'), reset: detectorCode(raw.reset, 'reset'),
      }
    }
    // 宿主函数不可克隆：只克隆纯数据部分，函数按引用挂在 spec 上。
    const meta = structuredClone({ plugin, ref, revision, ...(sessionId ? { sessionId } : {}), on, paramsSchema, stateSchema, resultSchema, timeoutMs, maxStateBytes, maxResultBytes })
    const spec: DetectorSpecification = {
      ...meta,
      ...(typeof input.builtin === 'string' ? { builtin: input.builtin } : {}),
      ...(hostCallbacks ? { hostCallbacks } : {}),
      ...(workerCallbacks ? { workerCallbacks } : {}),
    }
    const key = JSON.stringify([ref, sessionId ?? null]); registrations.set(key, spec); generation++
    return async () => {
      if (registrations.get(key) !== spec) return
      registrations.delete(key); generation++
      const runs = [...active].filter(run => run.specifications.includes(spec))
      for (const run of runs) run.controller.abort(new Error('detector-disposed'))
      await Promise.allSettled(runs.map(run => run.done))
      await releaseAll([...scopes].filter(([, scope]) => scope.specifications.includes(spec)).map(([id]) => () => release(id, 'detector-disposed')))
    }
  }
  const release = async (id: string, reason = 'stream-closed', preserveFeed = false): Promise<void> => {
    const feed = feeds.get(id)
    if (!preserveFeed && feed) feed.cancelled = true
    const pendingReset = resets.get(id)
    if (pendingReset) {
      try { await pendingReset } catch (error) { await releaseAll([() => release(id, reason, preserveFeed)], error); throw error }
      return release(id, reason, preserveFeed)
    }
    const scope = scopes.get(id)
    if (!scope) { hostStates.delete(id); return }
    scopes.delete(id)
    const resetting = (async () => {
      const runs = [...active].filter(run => run.scope === id)
      for (const run of runs) run.controller.abort(new Error(reason))
      await Promise.allSettled(runs.map(run => run.done))
      // 宿主通路的收尾在本进程完成；Worker 通路的收尾发给 Worker。
      const host = scope.specifications.filter(spec => spec.hostCallbacks)
      const states = hostStates.get(id)
      if (host.length && states) { try { createHostDetectors(host, states).reset(reason) } finally { hostStates.delete(id) } }
      const remote = scope.specifications.filter(spec => !spec.hostCallbacks)
      if (remote.length && Object.keys(scope.states).length) await matcher.detect({ detectorSpecifications: remote, detectorStates: scope.states, detectorReset: reason })
    })()
    resets.set(id, resetting)
    try { await resetting } finally { if (resets.get(id) === resetting) resets.delete(id) }
  }
  for (const spec of builtinDetectorSpecifications) register(spec, true)
  const detect = async (input: DetectionInput, signal?: AbortSignal, { sessionId, scope, epoch, current = () => true }: DetectionOptions = {}): Promise<RuleEvent[]> => {
    if (closed) throw new Error('detector-registry-closed')
    const captured = generation
    const hostSpecifications: DetectorSpecification[] = [], workerSpecifications: DetectorSpecification[] = []
    const hostRules: NormalizedRuleV2[] = [], workerRules: NormalizedRuleV2[] = []
    for (const rule of input.rules) {
      // 非检测器规则带不受控正则，只能跟着 Worker 走：不能因为旁边挂了宿主检测器就搬上主线程。
      if (rule.match.kind !== 'detector') { workerRules.push(rule); continue }
      const spec = lookup(rule.match.ref, sessionId)
      if (!spec || spec.revision !== rule.match.revision || !spec.on.includes(input.stage)) continue
      if (spec.hostCallbacks) {
        if (!hostSpecifications.includes(spec)) hostSpecifications.push(spec)
        hostRules.push(rule)
      } else {
        if (!workerSpecifications.includes(spec)) workerSpecifications.push(spec)
        workerRules.push(rule)
      }
    }
    if (scope && (typeof scope !== 'string' || typeof sessionId !== 'string' || !sessionId)) throw new Error('detector-stream-identity-required')
    const previousScope = scope ? scopes.get(scope) : undefined
    if (previousScope && previousScope.sessionId !== sessionId) throw new Error('detector-stream-session-conflict')
    if (previousScope?.busy) throw new Error('detector-stream-concurrent-feed')
    if (scope && previousScope && previousScope.epoch !== epoch) await release(scope, 'policy-changed', true)
    if (!hostSpecifications.length && !workerSpecifications.length) {
      if (scope) await release(scope, 'detectors-inactive', true)
      if (closed || generation !== captured || !current()) throw new Error('detector-policy-changed')
      return outputOf({ events: await matcher.detect({ ...input, rules: workerRules }, signal), states: {} }).events
    }
    if (closed || generation !== captured || !current()) throw new Error('detector-policy-changed')
    if (signal?.aborted) throw signal.reason ?? new Error('detector-cancelled')
    if (scope && !scopes.has(scope) && scopes.size >= maxScopes) throw new Error('detector-scope-budget-exceeded')
    const held: ScopeState = scope ? scopes.get(scope) ?? { states: {}, specifications: [], epoch, sessionId, busy: false } : { states: {}, specifications: [], busy: false }
    if (scope) { held.busy = true; scopes.set(scope, held) }
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    const run: ActiveRun = { controller, specifications: [...hostSpecifications, ...workerSpecifications], scope }; active.add(run)
    run.done = (async () => {
      try {
        // 宿主通路先跑：同一进程内同步完成，且它的独占组结果要交给 Worker 侧避让。
        let localEvents: RuleEvent[] = []
        if (hostSpecifications.length) {
          const previous = (scope ? hostStates.get(scope) : undefined) ?? {}
          const detectors = createHostDetectors(hostSpecifications, previous)
          localEvents = detectRulesV2({ ...input, rules: hostRules, detectorMatch: detectors.match })
          const states = mergeStates(previous, detectors.updated)
          if (scope) {
            const retainedBytes = [...hostStates.entries()].filter(([id]) => id !== scope).reduce((bytes, [, value]) => bytes + Buffer.byteLength(JSON.stringify(value), 'utf8'), 0)
            if (retainedBytes + Buffer.byteLength(JSON.stringify(states), 'utf8') > maxStateBytes) throw new Error('detector-stream-state-budget-exceeded')
            hostStates.set(scope, states)
          }
        }
        // 只有宿主规则时不必进 Worker；只要还有非检测器规则或 Worker 检测器规则就得走一趟。
        if (!workerRules.length) {
          if (closed || controller.signal.aborted || generation !== captured || !current() || scope && scopes.get(scope) !== held) throw new Error('detector-policy-changed')
          if (scope) held.specifications = [...new Set([...held.specifications, ...hostSpecifications])]
          return localEvents
        }
        // 宿主已决出的独占组连同决出者的排序键一起交给 Worker：那边只跳过排在后面的规则。
        const blockedGroups = claimedGroups(localEvents, hostRules)
        const output = outputOf(await matcher.detect({ ...input, rules: workerRules, blockedGroups, detectorSpecifications: workerSpecifications, detectorStates: held.states }, controller.signal))
        if (closed || controller.signal.aborted || generation !== captured || !current() || scope && scopes.get(scope) !== held) throw new Error('detector-policy-changed')
        assertDetectorJson(output.states)
        if (scope) {
          const states = mergeStates(held.states, output.states)
          const retainedBytes = [...scopes.values()].filter(value => value !== held).reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value.states), 'utf8'), 0)
          if (retainedBytes + Buffer.byteLength(JSON.stringify(states), 'utf8') > maxStateBytes) throw new Error('detector-stream-state-budget-exceeded')
          held.states = states; held.specifications = [...new Set([...held.specifications, ...workerSpecifications])]
        }
        return mergeEvents(localEvents, output.events, input.rules)
      } finally { held.busy = false; signal?.removeEventListener('abort', abort); active.delete(run) }
    })()
    return run.done
  }
  return {
    register: (specification: unknown) => register(specification), token: () => generation,
    available(rule: NormalizedRuleV2, sessionId: string, stage: string) {
      if (rule.match.kind !== 'detector') return false
      const spec = lookup(rule.match.ref, sessionId); return spec?.revision === rule.match.revision && spec.on.includes(stage)
    },
    catalog: () => [...registrations.values()].map(({ hostCallbacks: _host, workerCallbacks: _worker, ...spec }) => structuredClone(spec)),
    async detect(input: DetectionInput, signal?: AbortSignal, options: DetectionOptions = {}) {
      const { scope } = options
      if (!scope) return detect(input, signal, options)
      if (feeds.has(scope) || resets.has(scope)) throw new Error('detector-stream-concurrent-feed')
      const claim: { cancelled: boolean; done?: Promise<RuleEvent[]> } = { cancelled: false }; feeds.set(scope, claim)
      const current = options.current ?? (() => true)
      claim.done = detect(input, signal, { ...options, current: () => !claim.cancelled && current() })
      try { return await claim.done } finally { if (feeds.get(scope) === claim) feeds.delete(scope) }
    },
    release: (id: string, reason?: string) => release(id, reason),
    async releaseBlock(scopeId: string, blockKey: unknown) {
      if (feeds.has(scopeId) || resets.has(scopeId)) throw new Error('detector-stream-concurrent-feed')
      const scope = scopes.get(scopeId)
      if (!scope) return
      const host = scope.specifications.filter(spec => spec.hostCallbacks)
      const states = hostStates.get(scopeId)
      if (host.length && states) {
        const dropped = Object.fromEntries(Object.entries(states).filter(([, value]) => value.blockKey === blockKey))
        for (const key of Object.keys(dropped)) delete states[key]
        if (Object.keys(dropped).length) createHostDetectors(host, dropped).reset('block-ended')
      }
      const remote = scope.specifications.filter(spec => !spec.hostCallbacks)
      const remoteStates = Object.fromEntries(Object.entries(scope.states).filter(([, value]) => value.blockKey === blockKey))
      for (const key of Object.keys(remoteStates)) delete scope.states[key]
      if (remote.length && Object.keys(remoteStates).length) {
        const resetting = matcher.detect({ detectorSpecifications: remote, detectorStates: remoteStates, detectorReset: 'block-ended' })
        resets.set(scopeId, resetting)
        try { await resetting } finally { if (resets.get(scopeId) === resetting) resets.delete(scopeId) }
      }
    },
    async close() {
      closed = true; generation++
      for (const claim of feeds.values()) claim.cancelled = true
      for (const run of active) run.controller.abort(new Error('detector-registry-closed'))
      await Promise.allSettled([...([...active].map(run => run.done)), ...[...feeds.values()].map(claim => claim.done), ...resets.values()])
      try { await releaseAll([...scopes.keys()].map(id => () => release(id, 'host-closed'))) }
      finally { scopes.clear(); registrations.clear(); feeds.clear(); resets.clear(); hostStates.clear() }
    },
  }
}
