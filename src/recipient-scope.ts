import { matchConditionV2 } from './block-rules.js'
import { Recipient, type RecipientScope } from './recipient-schema.js'
import { parseInput } from './input-schema.js'

export interface RecipientIdentity {
  sessionId: string
  agentPreset?: string
  agentPresetName?: string
  provider?: string
  model?: string
}
export type RecipientFacts = Omit<RecipientIdentity, 'sessionId'>
export type { RecipientScope, RecipientCondition } from './recipient-schema.js'

export function normalizeScope(input: unknown = {}): RecipientScope { return parseInput(Recipient, input, 'recipient') }

/** Every declared dimension intersects; names and model IDs are case-sensitive. */
export function matchesScope(identity: RecipientIdentity, scope: RecipientScope) {
  if (scope.sessionIds !== undefined && !scope.sessionIds.includes(identity.sessionId)) return false
  if (scope.agentPresets !== undefined &&
      (identity.agentPreset === undefined || !scope.agentPresets.includes(identity.agentPreset))) return false
  return scope.condition === undefined || matchConditionV2(scope.condition, { session: { ...identity } }, undefined, { missingComparison: 'unmatched' }).ok
}
