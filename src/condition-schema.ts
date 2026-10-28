import { z } from 'zod'
import { CountConditionSchema } from './count-condition.js'
import { Field, Identifier, OwnedJson, parseInput } from './input-schema.js'
import { conditionTree, type BooleanCondition } from './condition-tree.js'

const Nonempty = z.string().min(1)
const Boundary = z.number({ error: 'must be a finite number' }).finite()
export const NumberComparisons = z.strictObject({ gte: Boundary.optional(), gt: Boundary.optional(), lte: Boundary.optional(), lt: Boundary.optional(), eq: Boundary.optional() },
  { error: issue => issue.code === 'unrecognized_keys' ? issue.keys.map(key => 'unknown comparison "' + key + '"').join('; ') : undefined })
  .refine(value => Object.keys(value).length > 0, 'must name at least one comparison')
export const NumberFacts = z.record(z.string(), NumberComparisons).refine(value => Object.keys(value).length > 0, 'must name at least one metric')
export const ArgumentFacts = z.record(z.string(), z.union([z.string(), z.array(z.string())]))
export const IdleFact = z.object({ since: Nonempty, minutes: z.number().finite().nonnegative() }).strict()
export const FactCondition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('glob'), field: Field, pattern: z.union([Nonempty, z.array(Nonempty).min(1)]) }).strict(),
  z.object({ kind: z.literal('arguments'), field: Field, contains: ArgumentFacts }).strict(),
  IdleFact.extend({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('numbers'), values: NumberFacts }).strict(),
  z.object({ kind: z.literal('text'), field: Field, pattern: Nonempty }).strict(),
  z.object({ kind: z.literal('surface'), placement: z.array(z.string()).default([]), markdownOnly: z.boolean().default(false),
    promptOnly: z.boolean().default(false), runOnEdit: z.boolean().default(false), minDepth: z.number().nullable().default(null), maxDepth: z.number().nullable().default(null) }).strict(),
])
export type FactConditionNode = z.infer<typeof FactCondition>

/** 计数、事实和其它叶节点由 schema 推导；布尔递归只在共同组合器中定义。 */
function leafAt(depth: number) {
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('always') }).strict(),
    z.object({ kind: z.literal('regex'), pattern: Nonempty.max(4096), flags: z.string().max(8).regex(/^[imsu]*$/, 'only i/m/s/u regex flags are supported').default(''),
      field: Field.optional(), all: z.boolean().optional() }).strict().superRefine((value, context) => {
      if (depth > 0 && value.all) context.addIssue({ code: 'custom', message: 'all regex matches require a root condition' })
      try { new RegExp(value.pattern, value.flags) } catch { context.addIssue({ code: 'custom', message: 'invalid regex pattern' }) }
    }),
    z.object({ kind: z.literal('keywords'), values: z.array(Nonempty.max(4096)).min(1).max(256), mode: z.enum(['ANY', 'ALL', 'NOT-ANY', 'NOT-ALL']).default('ANY'),
      caseSensitive: z.boolean().optional(), wordBoundary: z.boolean().optional(), field: Field.optional() }).strict(),
    z.object({ kind: z.literal('compare'), field: Field, op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']), value: z.unknown().optional() }).strict()
      .superRefine((value, context) => {
        if (value.op !== 'exists' && !Object.hasOwn(value, 'value')) context.addIssue({ code: 'custom', message: 'comparison value is required' })
        if (['gt', 'gte', 'lt', 'lte'].includes(value.op) && typeof value.value !== 'number') context.addIssue({ code: 'custom', message: 'numeric comparison requires a number' })
      }).overwrite(value => value.op === 'exists' ? { kind: value.kind, field: value.field, op: value.op } : { ...value, value: structuredClone(value.value) }),
    z.object({ kind: z.literal('detector'), ref: Identifier, revision: z.number().int().positive(), params: OwnedJson.optional() }).strict()
      .refine(() => depth === 0, 'detectors require a root condition'),
    CountConditionSchema, FactCondition,
  ])
}
export type ConditionNode = BooleanCondition<z.infer<ReturnType<typeof leafAt>>>
const tree = conditionTree(leafAt)
export const Condition = tree.schema
export function normalizeCondition(input: unknown, depth = 0): ConditionNode { return parseInput(depth === 0 ? Condition : tree.at(depth), input, 'condition') }
export function normalizeFactCondition(input: unknown): FactConditionNode { return parseInput(FactCondition, input, 'condition') }
