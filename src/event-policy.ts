import { z } from 'zod'
export { Recipient } from './recipient-schema.js'
import { CountLimits } from './count-condition.js'
import { RuleLimit } from './catalog-capacity.js'

const Id = z.string().min(1).max(256)
const ClockTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
const TimeWindow = z.object({ start: ClockTime, end: ClockTime, timeZone: z.literal('local').default('local') }).strict()
  .refine(value => value.start !== value.end, 'timeWindow must have different start and end')
const Regex = z.object({ regex: z.string().min(1).max(4096), flags: z.string().regex(/^[gimsu]*$/).default('') }).strict()
const Pattern = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), text: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('keywords'), values: z.array(z.string().min(1).max(4096)).min(1).max(128), mode: z.enum(['any', 'all']).default('any') }).strict(),
  z.object({ kind: z.literal('regex'), regex: z.string().min(1).max(4096), flags: z.string().regex(/^[gimsu]*$/).default('') }).strict(),
])
/** 环境给出事件事实，规则只声明感兴趣的事实；正文条件仍使用统一 match 树。 */
export const EventSelector = z.object({ tool: Id.optional(), arguments: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), Regex).default({}),
  error: z.object({ code: Id }).strict().optional(), eventType: Id.optional(),
  blockTypes: z.array(z.enum(['text', 'reasoning'])).min(1).max(2).optional(), pattern: Pattern.optional(),
  timeWindow: TimeWindow.optional(), humanActivity: z.object({ withinSeconds: z.number().int().min(1).max(86400) }).strict().optional(),
}).strict()
export type EventSelection = z.infer<typeof EventSelector>
export type EventSelectionInput = z.input<typeof EventSelector>
/** 判定器二选一：`code` 是规则自带的函数表达式字符串（能力与状态都走 ctx），`ref` 是注册表里的具名判定器。 */
export const RuleJudge = z.union([
  z.object({ code: z.string().min(1).max(65536), params: z.json().optional(), timeoutMs: z.number().int().min(1).max(60000).optional() }).strict(),
  z.object({ ref: Id, revision: z.number().int().positive(), params: z.json().optional(), timeoutMs: z.number().int().min(1).max(60000).optional() }).strict(),
])
const SharedQuota = z.discriminatedUnion('reset', [
  z.object({ reset: z.literal('lifetime'), lifetime: Id, limit: z.number().int().min(1).max(10000) }).strict(),
  z.object({ reset: z.literal('window'), limit: z.number().int().min(1).max(10000) }).strict(),
])
/** 投递事实独立于候选缓存：只有真实消息提交才消费额度和持续时钟。 */
export const DeliveryPolicy = z.object({ model: z.object({ once: z.enum(['none', 'surface', 'window']), shared: SharedQuota.optional(),
  interrupt: z.literal('abort-resume').optional(), sticky: z.object({ lifetime: z.number().int().min(1).max(1000), cooldown: z.number().int().min(0).max(1000),
    clock: z.enum(['main-request', 'human-turn']).default('main-request') }).strict().optional(),
}).strict() }).strict()
export type ActionDelivery = z.infer<typeof DeliveryPolicy>
export const ToolDenial = z.object({ dangerous: z.literal(true), reason: z.string().min(1).max(1024) }).strict()
export const EVENT_STAGES = ['tool.succeeded', 'tool.failed', 'request.before', 'assistant.output', 'tool.before-execute', 'session.event']
export const DeliveryConfig = z.object({ countLimits: CountLimits,
  ruleTimeoutMs: z.number().int().min(1).max(60000).default(250), roundTimeoutMs: z.number().int().min(1).max(60000).default(1000),
  storageTimeoutMs: z.number().int().min(1).max(60000).default(3000), maxConcurrent: z.number().int().min(1).max(64).default(4),
  maxQueued: z.number().int().min(1).max(10000).default(128), maxReminderChain: z.number().int().min(1).max(64).default(8), maxRules: RuleLimit.default(0),
  maxBytes: z.number().int().min(1).max(33554432).default(1048576), maxClaimBytes: z.number().int().min(1).max(33554432).default(8388608),
  maxStreamChars: z.number().int().min(1).max(1048576).default(32768), maxStreamBlocks: z.number().int().min(1).max(1024).default(64),
  maxStreamPending: z.number().int().min(1).max(10000).default(32), maxStreamPendingBytes: z.number().int().min(1).max(33554432).default(4194304),
  streamEveryChars: z.number().int().min(1).max(32768).default(256), streamFlushMs: z.number().int().min(1).max(1000).default(50),
  maxInterruptsPerTurn: z.number().int().min(0).max(16).default(1), maxCandidates: z.number().int().min(1).max(10000).default(128),
  maxIdle: z.number().int().min(1).max(64).optional(), maxContextMessages: z.number().int().min(0).max(1000).default(8),
  maxContextChars: z.number().int().min(0).max(1048576).default(32768), maxToolExecutions: z.number().int().min(1).max(100000).default(4096),
}).strict().prefault({})
