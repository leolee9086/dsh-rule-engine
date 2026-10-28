import { z } from 'zod'

/** Committed snooze facts keep the exact windows selected by the original call. */
export const SNOOZE_FORMAT = 'context-care/snooze/v1'
export const SnoozeWindow = z.object({ sourceId: z.string().min(1), ruleId: z.string().min(1),
  key: z.string().min(1), until: z.number().finite() }).strict()
export type SnoozeWindowValue = z.infer<typeof SnoozeWindow>
export const SnoozeResult = z.object({ format: z.literal(SNOOZE_FORMAT), sessionId: z.string().min(1),
  summary: z.string(), windows: z.array(SnoozeWindow) }).strict()
export type SnoozeResultValue = z.infer<typeof SnoozeResult>
/** Narrow JSON schema shape supported by native tool protocols, without a DSH dependency. */
interface FactSchema {
  type: 'object' | 'array' | 'string' | 'number'
  additionalProperties?: boolean
  required?: string[]
  properties?: Record<string, FactSchema>
  items?: FactSchema
  enum?: string[]
}
export const snoozeResultSchema = {
  type: 'object', additionalProperties: false, required: ['format', 'sessionId', 'summary', 'windows'], properties: {
    format: { type: 'string', enum: [SNOOZE_FORMAT] }, sessionId: { type: 'string' }, summary: { type: 'string' },
    windows: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['sourceId', 'ruleId', 'key', 'until'], properties: { sourceId: { type: 'string' },
        ruleId: { type: 'string' }, key: { type: 'string' }, until: { type: 'number' } } } },
  },
} satisfies FactSchema

/** The environment supplies presentation text; the engine owns fact identity. */
export function createSnoozeResult(sessionId: string, windows: SnoozeWindowValue[], summary: string): SnoozeResultValue {
  return { format: SNOOZE_FORMAT, sessionId, windows, summary }
}

/** Metadata wins over a retained text body. Legacy prose proves no window identity. */
export function readSnoozeResult(content: readonly unknown[], meta: unknown): SnoozeResultValue | undefined {
  const retained = SnoozeResult.safeParse(meta)
  if (retained.success) return retained.data
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const text = 'text' in block && typeof block.text === 'string' ? block.text : undefined
    if (text === undefined || !('type' in block) || block.type !== 'text') continue
    let value: unknown
    try { value = JSON.parse(text) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      continue
    }
    const parsed = SnoozeResult.safeParse(value)
    if (parsed.success) return parsed.data
  }
  return undefined
}
