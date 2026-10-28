import { z } from 'zod'
import type { ActionRunRecord, EngineRuntime } from './runtime-types.js'

const Run = z.object({ id: z.string(), status: z.string(), kind: z.string().optional(), key: z.string().optional(), sourceId: z.string().optional(), ruleId: z.string().optional(),
  ruleRevision: z.number().optional(), actionId: z.string().optional(), occurrenceId: z.string().optional(), dispatchId: z.string().optional(), blockId: z.string().optional(),
  sourceSeqs: z.array(z.number()).optional(), triggerSeq: z.number().optional(), result: z.record(z.string(), z.unknown()).optional(), reason: z.string().nullable().optional(),
  delivery: z.string().optional(), createdAt: z.number().optional(), updatedAt: z.number().optional(), startedAt: z.number().optional(), finishedAt: z.number().optional(),
  cancellationRequested: z.boolean().optional(), controlToken: z.string().optional(),
}).catchall(z.unknown())

/** 原存储接受任意 JSON；只有执行器自己的结构化记录参与调度和恢复。
 * 返回原始对象引用，避免校验重排字段或修改与 ACK 对应的运行事实。 */
export function isActionRunRecord(value: unknown): value is ActionRunRecord { return Run.safeParse(value).success }
export function actionRunRecords(runtime: EngineRuntime): ActionRunRecord[] { return runtime.runs.filter(isActionRunRecord) }
