import { z } from 'zod'
import { Condition, IdleFact, NumberFacts } from './condition-schema.js'
import { TextTransformFields, validateTextRegex } from './text-transform.js'
import { regexFromString, isRegexLiteral } from './regex.js'
import { PLACEMENT, SCOPE } from './placement.js'

const Nonempty = z.string().min(1)
const TextPattern = Nonempty.superRefine((value, context) => {
  if (!isRegexLiteral(value)) return
  try { regexFromString(value) } catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }) }
})
/** 同步输入只是共同规则的一种声明格式。字段校验与文本策略复用公共叶 schema。 */
export const TextWhen = z.object({
  ...TextTransformFields.partial().shape,
  provider: Nonempty.optional(), model: Nonempty.optional(), purpose: Nonempty.optional(),
  tool: z.union([Nonempty, z.array(Nonempty).min(1, 'must not be an empty array')]).optional(),
  args: z.record(z.string(), z.union([Nonempty, z.array(Nonempty).min(1, 'must not be an empty array')])).optional(),
  idle: IdleFact.strip().optional(), numbers: NumberFacts.optional(), said: TextPattern.optional(), produced: TextPattern.optional(),
  condition: Condition.optional(), disabled: z.boolean().optional(),
}).superRefine(validateTextRegex)
export const TextAction = z.object({ kind: z.enum(['notify', 'transform']), by: Nonempty.optional(), say: z.string().optional() })
const bool = (field: string) => z.boolean({ error: field + ' must be a boolean' })
export const TextRuleFields = z.object({
  id: z.string({ error: 'needs an explicit non-empty id' }).min(1, 'needs an explicit non-empty id'),
  scope: z.union([z.literal(SCOPE.GLOBAL), z.literal(SCOPE.SCOPED), z.literal(SCOPE.PRESET)], { error: 'unknown scope' }).default(SCOPE.GLOBAL),
  order: z.number({ error: 'needs an explicit order (a finite number)' }).finite(), enabled: bool('enabled').default(true),
  placement: z.array(z.enum(PLACEMENT, { error: 'unknown placement' })).default([]),
  depth: z.object({ min: z.number().finite().nullable().default(null), max: z.number().finite().nullable().default(null) }).default({ min: null, max: null }),
  markdownOnly: bool('markdownOnly').default(false), promptOnly: bool('promptOnly').default(false), runOnEdit: bool('runOnEdit').default(false),
  budget: z.object({ maxCacheLoss: z.number().finite().min(0).max(1).default(0) }).default({ maxCacheLoss: 0 }),
  cooldownMinutes: z.number().finite().nonnegative().default(0), oncePerSurface: bool('oncePerSurface').default(false),
})
