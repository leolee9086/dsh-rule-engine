import { z } from 'zod'
import { conditionTree } from './condition-tree.js'
import { Identifier } from './input-schema.js'

const Field = z.enum(['session.sessionId', 'session.agentPreset', 'session.agentPresetName', 'session.provider', 'session.model'])
const leaf = z.union([
  z.object({ kind: z.literal('compare'), field: Field, op: z.literal('exists') }).strict(),
  z.object({ kind: z.literal('compare'), field: Field, op: z.enum(['eq', 'ne', 'contains']), value: z.string().max(4096) }).strict(),
])
export const RecipientConditionSchema = conditionTree(() => leaf, { minChildren: 1, maxNodes: 128 }).schema
const ids = z.array(Identifier.min(1, 'entries must be non-empty strings up to 256 characters')).min(1, 'Too small: must be a non-empty array').max(128).transform(values => [...new Set(values)])
export const Recipient = z.strictObject({ sessionIds: ids.optional(), agentPresets: ids.optional(), condition: RecipientConditionSchema.optional() },
  { error: issue => issue.code === 'unrecognized_keys' ? 'Unrecognized key: unknown reminder scope field: ' + issue.keys.join(', ') : undefined })
export type RecipientCondition = z.infer<typeof RecipientConditionSchema>
export type RecipientScope = z.infer<typeof Recipient>
