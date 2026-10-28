import { detectorValidator } from './detector-protocol.js'
import { isRecord } from './guard.js'
import type { ActionExecutor } from './action-runs.js'

export interface ExecutorDeclaration {
  executorRef: string
  plugin: string
  toolName: string
  inputSchema: unknown
  requiresApproval?: boolean
  timeoutMs?: number
  maxResultBytes?: number
}
export interface ExecutorOperation<A> {
  agent: A
  inputs: unknown
  signal: AbortSignal
  runId: string
  toolName: string
}
export interface ExecutorPorts<A, R> {
  execute(input: ExecutorOperation<A>): Promise<R>
  /** 在原生结果上计量预算后，才生成动作可见的 value/content。 */
  result?(raw: R): unknown
  available(toolName: string): boolean
}
export interface RegisteredExecutor<A> extends ActionExecutor<A> {
  executorRef: string
  plugin: string
  maxResultBytes: number
}

/** 执行声明、输入校验及结果预算由引擎统一持有，宿主执行既定工具。 */
export function createExecutorRegistry<A, R>(ports: ExecutorPorts<A, R>) {
  const executors = new Map<string, RegisteredExecutor<A>>()
  const ownership = new Map<string, AbortController>()
  let generation = 0
  return {
    registerTool({ executorRef, plugin, toolName, inputSchema, requiresApproval = true, timeoutMs = 10000, maxResultBytes = 65536 }: ExecutorDeclaration) {
      if (!executorRef || !plugin || !toolName || executors.has(executorRef)) throw new Error('executor-registration-conflict')
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000 || !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1) throw new Error('executor-invalid-budget')
      if (typeof inputSchema !== 'boolean' && !isRecord(inputSchema)) throw new TypeError('executor-input-schema-required')
      const validate = detectorValidator(inputSchema), owner = new AbortController()
      const executor: RegisteredExecutor<A> = { executorRef, plugin, toolName, requiresApproval, timeoutMs, maxResultBytes, validate,
        errors: () => validate.errors,
        async run(input) {
          const signal = AbortSignal.any([input.signal, owner.signal])
          signal.throwIfAborted()
          let result: R
          try { result = await ports.execute({ ...input, signal, toolName }) }
          catch (error) {
            if (owner.signal.aborted) throw Object.assign(new Error('executor-unloaded-after-start', { cause: error }), { outcomeUnconfirmed: true })
            throw error
          }
          if (owner.signal.aborted) throw Object.assign(new Error('executor-unloaded-after-start'), { outcomeUnconfirmed: true })
          if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxResultBytes) throw Object.assign(new Error('executor-result-budget-exceeded'), { outcomeUnconfirmed: true })
          return ports.result ? ports.result(result) : result
        } }
      executors.set(executorRef, executor); ownership.set(executorRef, owner); generation++
      return () => { if (executors.get(executorRef) === executor) {
        executors.delete(executorRef); ownership.delete(executorRef); generation++
        owner.abort(new Error('executor-unloaded'))
      } }
    },
    get: (ref?: string) => ref === undefined ? undefined : executors.get(ref),
    token: () => generation,
    catalog: () => [...executors.values()].map(({ executorRef, plugin, toolName, requiresApproval, timeoutMs, maxResultBytes }) => ({ executorRef, plugin, toolName, requiresApproval, timeoutMs, maxResultBytes, available: ports.available(toolName) })),
    close() { executors.clear(); generation++; for (const owner of ownership.values()) owner.abort(new Error('executors-closed')); ownership.clear() },
  }
}
