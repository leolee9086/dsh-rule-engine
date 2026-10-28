import { createDeltaProjection, type DeltaChunk, type DeltaProjectionOptions, type DeltaBlock } from './delta-projection.js'
import type { ActionWorkItem } from './runtime-types.js'

export interface DeltaRuntimePorts {
  enabled(): boolean
  token(): string
  release(scope: string, reason?: string): unknown | Promise<unknown>
  releaseBlock(scope: string, index?: number): unknown | Promise<unknown>
  plan(blocks: readonly DeltaBlock[], signal: AbortSignal | undefined, projection: ReturnType<typeof createDeltaProjection>, scope: string): Promise<{ scheduled: ActionWorkItem[]; token: string }>
  enqueue(items: readonly ActionWorkItem[], token: string): unknown | Promise<unknown>
  drain(signal?: AbortSignal): unknown | Promise<unknown>
}
/** 流块收尾、策略失效、检测器释放和动作 ACK 在同一有界生命周期内协调。 */
export function openDeltaRuntime(options: DeltaProjectionOptions, ports: DeltaRuntimePorts) {
  const { sessionId, requestId, attemptId } = options
  if (!requestId || !attemptId) throw new Error('delta-request-identity-required')
  const projection = createDeltaProjection(options), scope = JSON.stringify([sessionId, requestId, attemptId])
  let policy: string | undefined
  return {
    async feed(chunk: DeltaChunk, signal?: AbortSignal): Promise<void> {
      const enabled = ports.enabled(), currentPolicy = ports.token()
      if (policy !== currentPolicy || !enabled) {
        await ports.release(scope, enabled ? 'policy-changed' : 'detectors-inactive')
        projection.feed({ type: 'inactive' }, currentPolicy); policy = currentPolicy
      }
      // 收尾先读取仍在内存中的有界证据，再移除实际块。
      const ending = ['block-end', 'finish'].includes(chunk.type)
      const final = enabled && ending ? projection.finalize(chunk.type === 'block-end' ? chunk.index : undefined) : []
      const blocks = ending ? final : projection.feed(enabled ? chunk : { type: 'inactive' }, currentPolicy)
      if (ending) projection.feed(chunk, currentPolicy)
      if (!blocks.length) {
        if (chunk.type === 'finish') await ports.release(scope)
        else if (chunk.type === 'block-end') await ports.releaseBlock(scope, chunk.index)
        return
      }
      const planned = await ports.plan(blocks, signal, projection, scope)
      await ports.enqueue(planned.scheduled, planned.token)
      projection.acknowledge(planned.scheduled.map(item => item.event))
      // 等待真实控制点，abort 及依赖的 followup 必须在下一 provider chunk 前结算。
      await ports.drain(signal)
      if (chunk.type === 'finish') await ports.release(scope)
      else if (chunk.type === 'block-end') await ports.releaseBlock(scope, chunk.index)
    },
    async close(): Promise<void> { projection.close(); await ports.release(scope) },
  }
}
