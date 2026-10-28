import { V2_STAGES, type NormalizedRuleV2, type RuleEvent, type V2Block } from './block-rules.js'
import { detectorCallbackSource, detectorValidator, assertDetectorJson, type DetectorSpecification, type DetectorStates, type DetectorHeldState } from './detector-protocol.js'
import { builtinDetectorSpecifications } from './builtin-detectors.js'
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
/** 检测器注册、临时状态、策略代次和 Worker 收尾统一属于引擎。 */
export function createDetectorRegistry(matcher: DetectionMatcher, { maxScopes = 128, maxStateBytes = 4194304 } = {}) {
  const registrations = new Map<string, DetectorSpecification>(), scopes = new Map<string, ScopeState>(), active = new Set<ActiveRun>()
  const feeds = new Map<string, { cancelled: boolean; done?: Promise<RuleEvent[]> }>(), resets = new Map<string, Promise<unknown>>()
  let generation = 0, closed = false
  const overlaps = (a?: string, b?: string) => !a || !b || a === b
  const lookup = (ref: string, sessionId?: string) => [...registrations.values()].find(spec => spec.ref === ref && (!spec.sessionId || spec.sessionId === sessionId))
  const register = (input: unknown, internal = false) => {
    if (closed) throw new Error('detector-registry-closed')
    if (registrations.size >= 128) throw new Error('detector-registration-budget-exceeded')
    if (!isRecord(input) || Object.keys(input).some(key => !['plugin', 'ref', 'revision', 'sessionId', 'on', 'paramsSchema', 'stateSchema', 'resultSchema', 'timeoutMs', 'maxStateBytes', 'maxResultBytes', 'callbacks', ...(internal ? ['builtin'] : [])].includes(key))) throw new Error('detector-invalid-registration-field')
    const { plugin, ref, revision, sessionId, on, paramsSchema, stateSchema, resultSchema, timeoutMs = 50, maxStateBytes = 262144, maxResultBytes = 65536 } = input
    if (typeof plugin !== 'string' || !plugin || plugin.length > 256 || typeof ref !== 'string' || !ref || ref.length > 256
      || sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId) || !bounded(revision, 1, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(on) || !on.length || !on.every((stage: unknown): stage is string => typeof stage === 'string' && V2_STAGES.some(value => value === stage))) throw new Error('detector-invalid-registration')
    if (!bounded(timeoutMs, 1, 100) || !bounded(maxStateBytes, 1, 1048576) || !bounded(maxResultBytes, 1, 1048576)) throw new Error('detector-invalid-budget')
    if ([...registrations.values()].some(spec => spec.ref === ref && overlaps(spec.sessionId, sessionId))) throw new Error('detector-registration-conflict')
    for (const schema of [paramsSchema, stateSchema, resultSchema]) detectorValidator(schema)
    if (input.builtin && !internal) throw new Error('detector-builtin-reserved')
    let callbacks: DetectorSpecification['callbacks']
    if (!input.builtin) {
      const raw = isRecord(input.callbacks) ? input.callbacks : {}
      callbacks = { initialize: detectorCallbackSource(raw.initialize), feed: detectorCallbackSource(raw.feed), finalize: detectorCallbackSource(raw.finalize), reset: detectorCallbackSource(raw.reset) }
    }
    const spec: DetectorSpecification = structuredClone({ plugin, ref, revision, ...(sessionId ? { sessionId } : {}), on, paramsSchema, stateSchema, resultSchema, timeoutMs, maxStateBytes, maxResultBytes,
      ...(typeof input.builtin === 'string' ? { builtin: input.builtin } : { callbacks }) })
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
    if (!scope) return
    scopes.delete(id)
    const resetting = (async () => {
      const runs = [...active].filter(run => run.scope === id)
      for (const run of runs) run.controller.abort(new Error(reason))
      await Promise.allSettled(runs.map(run => run.done))
      if (Object.keys(scope.states).length) await matcher.detect({ detectorSpecifications: scope.specifications, detectorStates: scope.states, detectorReset: reason })
    })()
    resets.set(id, resetting)
    try { await resetting } finally { if (resets.get(id) === resetting) resets.delete(id) }
  }
  for (const spec of builtinDetectorSpecifications) register(spec, true)
  const detect = async (input: DetectionInput, signal?: AbortSignal, { sessionId, scope, epoch, current = () => true }: DetectionOptions = {}): Promise<RuleEvent[]> => {
    if (closed) throw new Error('detector-registry-closed')
    const captured = generation, specifications: DetectorSpecification[] = []
    const rules = input.rules.filter(rule => {
      if (rule.match.kind !== 'detector') return true
      const spec = lookup(rule.match.ref, sessionId)
      if (!spec || spec.revision !== rule.match.revision || !spec.on.includes(input.stage)) return false
      if (!specifications.includes(spec)) specifications.push(spec)
      return true
    })
    if (scope && (typeof scope !== 'string' || typeof sessionId !== 'string' || !sessionId)) throw new Error('detector-stream-identity-required')
    const previousScope = scope ? scopes.get(scope) : undefined
    if (previousScope && previousScope.sessionId !== sessionId) throw new Error('detector-stream-session-conflict')
    if (previousScope?.busy) throw new Error('detector-stream-concurrent-feed')
    if (scope && previousScope && previousScope.epoch !== epoch) await release(scope, 'policy-changed', true)
    if (!specifications.length) {
      if (scope) await release(scope, 'detectors-inactive', true)
      if (closed || generation !== captured || !current()) throw new Error('detector-policy-changed')
      return outputOf({ events: await matcher.detect({ ...input, rules }, signal), states: {} }).events
    }
    if (closed || generation !== captured || !current()) throw new Error('detector-policy-changed')
    if (signal?.aborted) throw signal.reason ?? new Error('detector-cancelled')
    if (scope && !scopes.has(scope) && scopes.size >= maxScopes) throw new Error('detector-scope-budget-exceeded')
    const held: ScopeState = scope ? scopes.get(scope) ?? { states: {}, specifications, epoch, sessionId, busy: false } : { states: {}, specifications: [], busy: false }
    if (scope) { held.busy = true; scopes.set(scope, held) }
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    const run: ActiveRun = { controller, specifications, scope }; active.add(run)
    run.done = (async () => {
      try {
        const output = outputOf(await matcher.detect({ ...input, rules, detectorSpecifications: specifications, detectorStates: held.states }, controller.signal))
        if (closed || controller.signal.aborted || generation !== captured || !current() || scope && scopes.get(scope) !== held) throw new Error('detector-policy-changed')
        assertDetectorJson(output.states)
        if (scope) {
          const states = { ...held.states }
          for (const [key, value] of Object.entries(output.states)) { if (value === null) delete states[key]; else states[key] = value }
          const retainedBytes = [...scopes.values()].filter(value => value !== held).reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value.states), 'utf8'), 0)
          if (retainedBytes + Buffer.byteLength(JSON.stringify(states), 'utf8') > maxStateBytes) throw new Error('detector-stream-state-budget-exceeded')
          held.states = states; held.specifications = [...new Set([...held.specifications, ...specifications])]
        }
        return output.events
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
    catalog: () => [...registrations.values()].map(({ callbacks: _callbacks, ...spec }) => structuredClone(spec)),
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
      const states = Object.fromEntries(Object.entries(scope.states).filter(([, value]) => value.blockKey === blockKey))
      for (const key of Object.keys(states)) delete scope.states[key]
      if (Object.keys(states).length) {
        const resetting = matcher.detect({ detectorSpecifications: scope.specifications, detectorStates: states, detectorReset: 'block-ended' })
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
      finally { scopes.clear(); registrations.clear(); feeds.clear(); resets.clear() }
    },
  }
}
