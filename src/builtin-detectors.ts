import { createView, appendText, DETECTORS, WINDOWED_EVERY, type StreamView, type StreamSpec, type StreamState, type StreamHit } from './stream-watch.js'
import { detectDegradation, PATTERN_IDS, type LoopHit } from './loop-patterns.js'
import { isRecord } from './guard.js'
import type { DetectorCallbackName } from './detector-protocol.js'

const empty = () => ({ ok: false, ranges: [], captures: {}, facts: {} })
const result = (hit?: StreamHit | LoopHit) => hit ? { ok: true, ranges: [], captures: {}, facts: hit } : empty()
function unpackView(value: unknown): StreamView {
  if (!isRecord(value) || !Array.isArray(value.chunks) || !value.chunks.every((child: unknown) => typeof child === 'string')
    || !Array.isArray(value.window) || !value.window.every((child: unknown) => typeof child === 'string') || !Array.isArray(value.counts)
    || typeof value.length !== 'number' || typeof value.line !== 'string' || typeof value.bytes !== 'number') throw new Error('detector-builtin-state-invalid')
  const counts = new Map<string, number>()
  for (const pair of value.counts) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'number') throw new Error('detector-builtin-state-invalid')
    counts.set(pair[0], pair[1])
  }
  return { chunks: value.chunks, length: value.length, line: value.line, window: value.window, counts, bytes: value.bytes }
}
function specOf(input: Record<string, unknown>): StreamSpec {
  if (!isRecord(input.params)) throw new Error('detector-builtin-params-invalid')
  const { token, phrases, minLines, minCount, minRun, minRatio, everyBytes } = input.params
  if (token !== undefined && typeof token !== 'string' || phrases !== undefined && (!Array.isArray(phrases) || !phrases.every((value: unknown) => typeof value === 'string'))
    || [minLines, minCount, minRun, minRatio, everyBytes].some(value => value !== undefined && typeof value !== 'number')) throw new Error('detector-builtin-params-invalid')
  return { ...(typeof token === 'string' ? { token } : {}), ...(Array.isArray(phrases) ? { phrases: phrases.filter((value: unknown): value is string => typeof value === 'string') } : {}),
    ...(typeof minLines === 'number' ? { minLines } : {}), ...(typeof minCount === 'number' ? { minCount } : {}), ...(typeof minRun === 'number' ? { minRun } : {}),
    ...(typeof minRatio === 'number' ? { minRatio } : {}), ...(typeof everyBytes === 'number' ? { everyBytes } : {}) }
}
function streamState(value: unknown): StreamState {
  if (!isRecord(value) || typeof value.token !== 'string' || typeof value.carry !== 'string' || !Array.isArray(value.phrases)
    || !value.phrases.every((child: unknown) => typeof child === 'string') || typeof value.keep !== 'number') throw new Error('detector-builtin-state-invalid')
  return { token: value.token, carry: value.carry, phrases: value.phrases, keep: value.keep }
}
export type DetectorCallbacks = Record<DetectorCallbackName, (input: Record<string, unknown>) => unknown>
/** 保留原检测算法、增量节奏与 finalize 语义；阶段和参数声明同实际检测器对应。 */
export function builtinDetectorCallbacks(name: string): DetectorCallbacks {
  if (name === 'degradation') return {
    initialize: () => null,
    reset: () => null,
    feed: ({ state }) => ({ state, result: empty() }),
    finalize({ state, block, params }) {
      if (!isRecord(block) || typeof block.text !== 'string' || !isRecord(params)) throw new Error('detector-builtin-params-invalid')
      const only = params.only
      if (only !== undefined && (!Array.isArray(only) || !only.every((value: unknown) => typeof value === 'string'))) throw new Error('detector-builtin-params-invalid')
      return { state, result: result(detectDegradation(block.text, only)) }
    },
  }
  const detector = DETECTORS[name]
  if (!detector) throw new Error('builtin-detector-unavailable')
  const initialize = (input: Record<string, unknown>) => ({ detector: detector.create(specOf(input)), view: { ...createView(), counts: [] } })
  const calculate = (input: Record<string, unknown>, final: boolean) => {
    const { state, delta } = input
    if (!isRecord(state) || typeof delta !== 'string') throw new Error('detector-builtin-state-invalid')
    const params = specOf(input), view = unpackView(state.view), held = streamState(state.detector)
    let hit: StreamHit | undefined
    if (detector.cadence === 'incremental') hit = detector.feed(held, delta, params)
    else {
      appendText(view, delta)
      if (final || view.bytes >= (params.everyBytes ?? WINDOWED_EVERY)) {
        view.bytes = 0; hit = detector.check(view, held, params)
      }
    }
    return { state: { detector: held, view: { ...view, counts: [...view.counts] } }, result: result(hit) }
  }
  return { initialize, reset: initialize, feed: input => calculate(input, false), finalize: input => calculate(input, true) }
}
const boundedNumber = { type: 'integer', minimum: 1, maximum: 32768 }
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, additionalProperties: false })
const definitions: readonly (readonly [string, ReturnType<typeof object>])[] = [
  ['marker', object({ token: { type: 'string', minLength: 1, maxLength: 4096 } })],
  ['phrase', object({ phrases: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1, maxLength: 4096 } } })],
  ['line-repeat', object({ minLines: boundedNumber, minCount: boundedNumber, minRun: boundedNumber, minRatio: { type: 'number', minimum: 0, maximum: 1 }, everyBytes: boundedNumber })],
  ['degradation', object({ only: { type: 'array', maxItems: PATTERN_IDS.length, items: { type: 'string', enum: PATTERN_IDS } } })],
]
export const builtinDetectorSpecifications = definitions.map(([builtin, paramsSchema]) => ({ plugin: 'dsh-context-care', ref: `context-care:${builtin}`, revision: 1, builtin,
  on: builtin === 'degradation' ? ['request.assemble', 'output.complete', 'tool.result', 'display.render'] : ['output.delta', 'output.complete', 'display.render', 'request.assemble'],
  paramsSchema: { ...paramsSchema, ...(builtin === 'marker' ? { required: ['token'] } : builtin === 'phrase' ? { required: ['phrases'] } : {}) },
  stateSchema: {}, resultSchema: {}, timeoutMs: 50, maxStateBytes: 262144, maxResultBytes: 65536 }))
