import type { ValidateFunction } from 'ajv'
import { validateDetectorEvidenceV2, type NormalizedRuleV2, type ConditionSnapshot } from './block-rules.js'
import { detectorValidator, validateDetectorValue, type DetectorSpecification, type DetectorStates, type DetectorHeldState, type DetectorCallbackName } from './detector-protocol.js'
import { isRecord } from './guard.js'

const schemas = new Map<string, ValidateFunction<unknown>>()

/** 一次回调调用：名字 + 入参，返回 JSON。 */
export type CallbackCall = (name: DetectorCallbackName, input: Record<string, unknown>) => unknown

/**
 * 检测器的生命周期：初始化、增量喂入、收尾、重置、状态记账。
 *
 * 这份逻辑与「回调在哪个进程执行」无关：宿主通路给它直接调用的函数，
 * Worker 通路给它 vm 里编译出来的函数。两条通路共用同一套状态机与校验，
 * 差别只在 {@link CallbackCall} 的来源。
 */
export function createDetectorLifecycle(specifications: readonly DetectorSpecification[], previous: DetectorStates, callOf: (spec: DetectorSpecification) => CallbackCall) {
  const updated: Record<string, DetectorHeldState | null> = {}
  const runtimes = new Map<string, { spec: DetectorSpecification; call: CallbackCall;
    validateState: ValidateFunction<unknown>; validateResult: ValidateFunction<unknown>; validateParams: ValidateFunction<unknown> }>()
  for (const spec of specifications) {
    const validateState = detectorValidator(spec.stateSchema, schemas), validateResult = detectorValidator(spec.resultSchema, schemas), validateParams = detectorValidator(spec.paramsSchema, schemas)
    runtimes.set(spec.ref, { spec, call: callOf(spec), validateState, validateResult, validateParams })
  }
  function envelope(value: unknown, label: string): { state: unknown; result: unknown } {
    if (!isRecord(value) || Object.keys(value).some(key => !['state', 'result'].includes(key)) || !Object.hasOwn(value, 'state') || !Object.hasOwn(value, 'result')) throw new Error(`detector-invalid-${label}-envelope`)
    return { state: value.state, result: value.result }
  }
  return {
    updated,
    reset(reason: string) {
      for (const [key, held] of Object.entries(previous)) {
        const identity: unknown = JSON.parse(key), ref = Array.isArray(identity) ? identity[4] : undefined
        const runtime = typeof ref === 'string' ? runtimes.get(ref) : undefined
        if (!runtime) throw new Error('detector-reset-runtime-unavailable')
        const { spec, call, validateState } = runtime
        validateDetectorValue(validateState, call('reset', { params: held.params, state: held.state, reason }), 'state', spec.maxStateBytes)
      }
    },
    match(rule: NormalizedRuleV2, snapshot: ConditionSnapshot) {
      const stage = snapshot.stage
      if (typeof stage !== 'string') throw new Error('detector-stage-unavailable')
      if (rule.match.kind !== 'detector') throw new Error('detector-unavailable')
      const runtime = runtimes.get(rule.match.ref)
      if (!runtime || runtime.spec.revision !== rule.match.revision) throw new Error('detector-unavailable')
      const { spec, call, validateState, validateResult, validateParams } = runtime
      if (!spec.on.includes(stage)) throw new Error('detector-stage-unavailable')
      const params = validateDetectorValue(validateParams, rule.match.params ?? {}, 'params', spec.maxStateBytes)
      const key = JSON.stringify([rule.sourceId, rule.id, rule.revision, snapshot.block.id, spec.ref, spec.revision, snapshot.block.view]), held = previous[key]
      const base = { params, block: snapshot.block, snapshot }
      let state = held ? held.state : call('initialize', base)
      state = validateDetectorValue(validateState, state, 'state', spec.maxStateBytes)
      const length = snapshot.block.text?.length ?? 0
      if (held && length < held.offset) throw new Error('detector-stream-prefix-changed')
      const delta = (snapshot.block.text ?? '').slice(held?.offset ?? 0), fed = envelope(call('feed', { ...base, state, delta }), 'feed')
      state = validateDetectorValue(validateState, fed.state, 'state', spec.maxStateBytes)
      let matched = validateDetectorEvidenceV2(validateDetectorValue(validateResult, fed.result, 'result', spec.maxResultBytes), snapshot.block)
      if (snapshot.stage !== 'output.delta' || snapshot.block.detectorPhase === 'finalize') {
        const final = envelope(call('finalize', { ...base, state, delta: '' }), 'finalize')
        validateDetectorValue(validateState, final.state, 'state', spec.maxStateBytes)
        const finalized = validateDetectorEvidenceV2(validateDetectorValue(validateResult, final.result, 'result', spec.maxResultBytes), snapshot.block)
        if (finalized.ok || finalized.matches?.some(value => value.ok)) matched = finalized
        validateDetectorValue(validateState, call('reset', { ...base, state: final.state, reason: 'finalized' }), 'state', spec.maxStateBytes)
        updated[key] = null
      } else updated[key] = { state, offset: length, params, ...(snapshot.block.blockKey === undefined ? {} : { blockKey: snapshot.block.blockKey }) }
      return matched
    },
  }
}
