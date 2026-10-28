import { createContext, Script } from 'node:vm'
import type { ValidateFunction } from 'ajv'
import { validateDetectorEvidenceV2, type NormalizedRuleV2, type ConditionSnapshot } from './block-rules.js'
import { detectorValidator, validateDetectorValue, assertDetectorJson, type DetectorSpecification, type DetectorStates, type DetectorHeldState, type DetectorCallbackName } from './detector-protocol.js'
import { builtinDetectorCallbacks } from './builtin-detectors.js'
import { isRecord } from './guard.js'

const schemas = new Map<string, ValidateFunction<unknown>>()
export function createWorkerDetectors(specifications: readonly DetectorSpecification[], previous: DetectorStates = {}) {
  const updated: Record<string, DetectorHeldState | null> = {}
  const runtimes = new Map<string, { spec: DetectorSpecification; call(name: DetectorCallbackName, input: Record<string, unknown>): unknown;
    validateState: ValidateFunction<unknown>; validateResult: ValidateFunction<unknown>; validateParams: ValidateFunction<unknown> }>()
  for (const spec of specifications) {
    const validateState = detectorValidator(spec.stateSchema, schemas), validateResult = detectorValidator(spec.resultSchema, schemas), validateParams = detectorValidator(spec.paramsSchema, schemas)
    let call: (name: DetectorCallbackName, input: Record<string, unknown>) => unknown
    if (spec.builtin) {
      const callbacks = builtinDetectorCallbacks(spec.builtin)
      call = (name, input) => callbacks[name](structuredClone(input))
    } else {
      if (!spec.callbacks) throw new Error('detector-callbacks-unavailable')
      const context = createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
      new Script(`const callbacks = { ${Object.entries(spec.callbacks).map(([name, source]) => `${name}: (${source})`).join(',')} }; const assertDetectorJson = ${assertDetectorJson.toString()};`).runInContext(context, { timeout: spec.timeoutMs })
      call = (name, input) => {
        const text: unknown = new Script(`(() => { const output = callbacks.${name}(JSON.parse(${JSON.stringify(JSON.stringify(input))})); assertDetectorJson(output); return JSON.stringify(output) })()`)
          .runInContext(context, { timeout: spec.timeoutMs })
        if (typeof text !== 'string') throw new Error('detector-result-must-be-json')
        return JSON.parse(text)
      }
    }
    runtimes.set(spec.ref, { spec, call, validateState, validateResult, validateParams })
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
