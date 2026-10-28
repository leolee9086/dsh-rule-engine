import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { detectRulesV2, normalizeRuleV2, type V2Block } from './block-rules.js'
import { createWorkerDetectors } from './detector-worker.js'
import { progressWriter } from './matcher-progress.js'
import { executeEventMatch, executeEventBatch } from './event-matcher.js'
import { Detector, Event } from './event-state.js'
const Analysis = z.object({ analyzer: Detector, event: Event, maxBytes: z.number().int().positive() }).strict()
const Facts = z.record(z.string(), z.json())
export async function executeEventAnalysis(raw: unknown) {
  const { analyzer, event, maxBytes } = Analysis.parse(raw)
  const loaded: unknown = await import(analyzer.module)
  if (!isRecord(loaded) || typeof loaded[analyzer.exportName] !== 'function') throw new Error('reminder-analyzer-export-missing')
  const evaluate = loaded[analyzer.exportName]
  if (typeof evaluate !== 'function') throw new Error('reminder-analyzer-export-missing')
  const facts = Facts.parse(await evaluate({ event, context: event.context ?? { messages: [], truncated: false } }))
  if (Buffer.byteLength(JSON.stringify(facts)) > maxBytes) throw new Error('reminder-analysis-budget-exceeded')
  return facts
}
import { serializeWorkerError } from './worker-error.js'
import { isRecord } from './guard.js'
import { executeTextTransforms } from './text-transform-plan.js'
import type { DetectorStates, DetectorSpecification } from './detector-protocol.js'

const Specification = z.object({ plugin: z.string(), ref: z.string(), revision: z.number(), sessionId: z.string().optional(), on: z.array(z.string()),
  paramsSchema: z.unknown(), stateSchema: z.unknown(), resultSchema: z.unknown(), timeoutMs: z.number(), maxStateBytes: z.number(), maxResultBytes: z.number(),
  builtin: z.string().optional(), callbacks: z.object({ initialize: z.string(), feed: z.string(), finalize: z.string(), reset: z.string() }).optional() }).strict()
const Held = z.object({ state: z.unknown(), offset: z.number(), params: z.unknown(), blockKey: z.unknown().optional() }).strict()
const Block = z.object({ id: z.string(), view: z.string(), role: z.string(), type: z.string(), text: z.string().optional(), seq: z.number().optional(),
  messageId: z.string().optional(), messageIndex: z.number().optional(), turnId: z.string().optional() }).catchall(z.unknown())
const Input = z.object({ rules: z.array(z.unknown()).default([]), blocks: z.array(Block).default([]), stage: z.string().default('raw.observe'),
  vars: z.record(z.string(), z.unknown()).optional(), session: z.record(z.string(), z.unknown()).optional(),
  detectorSpecifications: z.array(Specification).optional(), detectorStates: z.record(z.string(), Held).optional(), detectorReset: z.string().optional(), freshSeq: z.number().optional() }).catchall(z.unknown())
export function executeRuleTask(raw: unknown, context?: RuleWorkerContext): unknown {
  if (isRecord(raw)) {
    if (raw.textTransforms !== undefined) return executeTextTransforms(raw.textTransforms)
    if (raw.reminderBatch !== undefined) return executeEventBatch(raw.reminderBatch, item => context?.send({ item }), context?.checkpoint, context?.workTimeoutMs)
    if (raw.reminder !== undefined) return executeEventMatch(raw.reminder)
    if (raw.analysis !== undefined) return executeEventAnalysis(raw.analysis)
  }
  const input = Input.parse(raw), specifications: DetectorSpecification[] = input.detectorSpecifications ?? [], states: DetectorStates = input.detectorStates ?? {}
  const detectors = specifications.length ? createWorkerDetectors(specifications, states) : undefined
  if (input.detectorReset) { detectors?.reset(input.detectorReset); return { events: [], states: {} } }
  const rules = input.rules.map(normalizeRuleV2), blocks: V2Block[] = input.blocks
  const events = detectRulesV2({ ...input, rules, blocks, detectorMatch: detectors?.match })
  return detectors ? { events, states: detectors.updated } : events
}
const Envelope = z.object({ taskId: z.string(), input: z.record(z.string(), z.unknown()), progress: z.instanceof(SharedArrayBuffer), workTimeoutMs: z.number().finite().nonnegative() }).strict()
/** 单项和批处理共用同一条线程生命周期；批处理拥有各项检查点，队列与回执仍由这里拥有。 */
export interface RuleWorkerContext {
  send(value: Record<string, unknown>): void
  checkpoint: ReturnType<typeof progressWriter>
  workTimeoutMs: number
}
export interface RuleWorkerOptions {
  batch?(input: Record<string, unknown>): boolean
}
export function runRuleWorker(operation: (input: Record<string, unknown>, context: RuleWorkerContext) => unknown | Promise<unknown> = executeRuleTask,
  options: RuleWorkerOptions = { batch: input => input.reminderBatch !== undefined }): void {
  const port = parentPort
  if (!port) throw new Error('matcher-worker-requires-parent')
  const handle = async (raw: unknown): Promise<void> => {
    const parsed = Envelope.safeParse(raw)
    if (!parsed.success) {
      if (isRecord(raw) && typeof raw.taskId === 'string') port.postMessage({ taskId: raw.taskId, error: { name: 'TypeError', message: 'matcher-envelope-invalid' } })
      return
    }
    const { taskId, input, progress, workTimeoutMs } = parsed.data, checkpoint = progressWriter(progress)
    const send = (value: Record<string, unknown>) => port.postMessage({ taskId, ...value })
    try {
      send({ started: true })
      let result: unknown
      if (options.batch?.(input)) result = await operation(input, { send, checkpoint, workTimeoutMs })
      else {
        checkpoint.start(0, workTimeoutMs)
        let elapsedMs: number
        try { result = input.warmup ? null : await operation(input, { send, checkpoint, workTimeoutMs }) }
        finally { elapsedMs = checkpoint.finish(0) }
        if (elapsedMs > workTimeoutMs) throw new Error('matcher-work-timeout')
      }
      send({ result })
    } catch (error) { send({ error: serializeWorkerError(error, value => value instanceof Error ? value.message : String(value)) }) }
    finally { checkpoint.done() }
  }
  let queue = Promise.resolve()
  port.on('message', (raw: unknown) => {
    // 回执无法进入 MessagePort 时，真实线程失败；容量必须等它退出后才能释放。
    queue = queue.then(() => handle(raw), () => handle(raw)).catch((error: unknown) => {
      setImmediate(() => { throw error })
    })
  })
  port.postMessage({ ready: true })
}
const launch: unknown = workerData
if (parentPort && isRecord(launch) && launch.dshRuleWorker === true) runRuleWorker()
