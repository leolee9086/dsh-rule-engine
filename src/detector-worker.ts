import { createContext, Script } from 'node:vm'
import { createDetectorLifecycle, type CallbackCall } from './detector-lifecycle.js'
import { assertDetectorJson, type DetectorSpecification, type DetectorStates } from './detector-protocol.js'
import { builtinDetectorCallbacks } from './builtin-detectors.js'

/**
 * Worker 通路：回调在 Worker 进程里执行。
 *
 * 内建检测器直接用函数；外部检测器只接受源码字符串，在 vm 里编译后执行——
 * 函数对象过不了进程边界，这条通路本来就不该假装能传函数。
 */
export function createWorkerDetectors(specifications: readonly DetectorSpecification[], previous: DetectorStates = {}) {
  return createDetectorLifecycle(specifications, previous, workerCall)
}

function workerCall(spec: DetectorSpecification): CallbackCall {
  if (spec.builtin) {
    const callbacks = builtinDetectorCallbacks(spec.builtin)
    return (name, input) => callbacks[name](structuredClone(input))
  }
  if (!spec.workerCallbacks) throw new Error('detector-worker-callbacks-unavailable')
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
  new Script(`const callbacks = { ${Object.entries(spec.workerCallbacks).map(([name, source]) => `${name}: (${source})`).join(',')} }; const assertDetectorJson = ${assertDetectorJson.toString()};`).runInContext(context, { timeout: spec.timeoutMs })
  return (name, input) => {
    const text: unknown = new Script(`(() => { const output = callbacks.${name}(JSON.parse(${JSON.stringify(JSON.stringify(input))})); assertDetectorJson(output); return JSON.stringify(output) })()`)
      .runInContext(context, { timeout: spec.timeoutMs })
    if (typeof text !== 'string') throw new Error('detector-result-must-be-json')
    return JSON.parse(text)
  }
}
