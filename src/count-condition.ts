import { z } from 'zod'
import { TextCountConfig, measureTextCount, type TextCountResult } from './text-count.js'

import { Field } from './input-schema.js'
export { Field, pathParts } from './input-schema.js'

/** Host measurement ceilings; rules may choose smaller limits, never larger ones. */
export const CountLimits = TextCountConfig.shape.limits.default({
  maxTextChars: 32768, maxCandidates: 10000, maxUnits: 10000, maxEvidence: 32,
})
export type CountLimitValues = z.infer<typeof CountLimits>
const TextSource = z.object({ kind: z.literal('text'), field: Field,
  projection: TextCountConfig.shape.projection, locale: TextCountConfig.shape.locale,
  metaPrefixes: TextCountConfig.shape.metaPrefixes }).strict()
export const CountConditionSchema = z.object({ kind: z.literal('count'), source: TextSource,
  pattern: TextCountConfig.shape.pattern, metric: TextCountConfig.shape.metric,
  window: z.object({ kind: z.enum(['current-block', 'current-output']) }).strict(),
  evaluate: z.enum(['complete', 'prefix']).default('complete'),
  compare: TextCountConfig.shape.compare, limits: CountLimits,
}).strict().superRefine((value, context) => {
  const measurement = TextCountConfig.safeParse(measurementOptions(value))
  if (!measurement.success) for (const issue of measurement.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path })
})

export type CountCondition = z.infer<typeof CountConditionSchema>
export function measurementOptions(value: { source: z.infer<typeof TextSource>; pattern: z.infer<typeof TextCountConfig.shape.pattern>;
  metric: z.infer<typeof TextCountConfig.shape.metric>; compare: z.infer<typeof TextCountConfig.shape.compare>; limits: CountLimitValues }) {
  return { projection: value.source.projection, locale: value.source.locale, metaPrefixes: value.source.metaPrefixes,
    pattern: value.pattern, metric: value.metric, compare: value.compare, limits: value.limits }
}

const TextSample = z.object({ field: Field, sampleId: z.string().min(1), window: z.enum(['current-block', 'current-output']), phase: z.enum(['prefix', 'complete']), truncated: z.boolean() }).strict()
export const TextSamples = z.array(TextSample).max(1024)
export type TextSampleValue = z.infer<typeof TextSample>
export function measureCondition(node: CountCondition, text: unknown, sample?: TextSampleValue): TextCountResult {
  const reason = !sample ? 'text-sample-unavailable' : sample.truncated ? 'text-sample-truncated'
    : node.evaluate === 'complete' && sample.phase !== 'complete' ? 'text-sample-incomplete'
      : typeof text !== 'string' ? 'text-field-unavailable' : undefined
  return reason !== undefined || typeof text !== 'string' ? { status: 'unavailable', reason: reason ?? 'text-field-unavailable' } : measureTextCount(text, measurementOptions(node))
}
