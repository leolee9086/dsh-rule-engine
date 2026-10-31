import { createDetectorLifecycle, type CallbackCall } from './detector-lifecycle.js'
import { assertDetectorJson, type DetectorSpecification, type DetectorStates } from './detector-protocol.js'

/**
 * 宿主通路：回调函数就在本进程里，直接调用。
 *
 * 不序列化、不转源码、不进 Worker。代价是没有 Worker 的超时与隔离——
 * 注册者交的是自己的代码，就该知道自己不能在这里写死循环。
 */
export function createHostDetectors(specifications: readonly DetectorSpecification[], previous: DetectorStates = {}) {
  return createDetectorLifecycle(specifications, previous, hostCall)
}

function hostCall(spec: DetectorSpecification): CallbackCall {
  if (spec.builtin) throw new Error('detector-builtin-cannot-run-in-host')
  const callbacks = spec.hostCallbacks
  if (!callbacks) throw new Error('detector-host-callbacks-unavailable')
  return (name, input) => {
    // 与 Worker 通路同样过一遍 JSON 校验：两条通路的契约必须一致。
    const output: unknown = Reflect.apply(callbacks[name], undefined, [structuredClone(input)])
    assertDetectorJson(output)
    return output
  }
}
