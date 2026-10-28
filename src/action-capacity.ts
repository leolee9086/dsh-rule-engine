interface Waiter { signal: AbortSignal; resolve(release: () => void): void; abort(): void }

/** 跨会话共享执行容量，取消中的等待者从队列释放。 */
export function createActionCapacity(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid-action-concurrency')
  let active = 0
  const waiting: Waiter[] = []
  function permit() {
    active++
    let released = false
    return () => {
      if (released) return
      released = true; active--
      const next = waiting.shift()
      if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(permit()) }
    }
  }
  return (signal: AbortSignal): Promise<() => void> => {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (active < limit) return Promise.resolve(permit())
    return new Promise((resolve, reject) => {
      const item: Waiter = { signal, resolve, abort() {
        const index = waiting.indexOf(item)
        if (index >= 0) waiting.splice(index, 1)
        reject(signal.reason)
      } }
      waiting.push(item); signal.addEventListener('abort', item.abort, { once: true })
    })
  }
}
/** 审批实际操作由端口提供，引擎统一处理等待与取消。 */
export function awaitApproval<T>(request: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return request() }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
