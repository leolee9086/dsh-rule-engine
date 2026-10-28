import { z } from 'zod'
import type { RuleEntry } from './declarations.js'
import type { ActionState } from './runtime-types.js'
import { isRecord } from './guard.js'

export const ActionStateSchema = z.object({ lastStarted: z.number().optional(), occurrenceId: z.string().optional(), turnId: z.string().optional(),
  lastActivationAt: z.number().optional(), lastInactiveAt: z.number().optional() }).catchall(z.unknown())
/** 存储允许扩展 JSON；读取本引擎拥有的状态键时才校验结构。 */
export function readActionState(value: unknown): ActionState | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError('action-state-must-be-object')
  return ActionStateSchema.parse(value)
}
const Materialization = z.object({ text: z.string(), turnId: z.string(), turn: z.number().int().nonnegative(),
  stickyUntilTurn: z.number().int().nonnegative().nullable() }).strict()
export interface EntryMoment { turnId: string; turn: number; now?: number }

/** 每次只判定激活与复用，持有文本按声明的生命周期和 sticky 区间使用。 */
export function entryPolicy(entry: RuleEntry, previousValue: unknown, { turnId, turn, matches, now = Date.now() }: EntryMoment & { matches: boolean }) {
  const previous = readActionState(previousValue)
  const materialization = previous?.materialization === undefined ? undefined : Materialization.parse(previous.materialization)
  const held = !!materialization && (entry.lifetime === 'session'
    || entry.lifetime === 'turn' && materialization.turnId === turnId
    || entry.lifetime === 'turns' && entry.lifetimeTurns !== undefined && turn >= materialization.turn && turn < materialization.turn + entry.lifetimeTurns
    || entry.lifetime === 'until-inactive' && matches)
  const sticky = !!materialization && materialization.stickyUntilTurn !== null && turn >= materialization.turn && turn <= materialization.stickyUntilTurn
  const reuse = held || sticky, inactive = !!materialization && !reuse && !matches
  const reason = reuse ? undefined
    : previous?.lastActivationAt !== undefined && now - previous.lastActivationAt < entry.cooldownMs ? 'entry-activation-interval'
      : previous?.lastInactiveAt !== undefined && now - previous.lastInactiveAt < entry.activationCooldownMs ? 'entry-inactive-cooldown' : undefined
  return { matches, reuse, inactive, reason, ...(reuse && materialization ? { text: materialization.text } : {}) }
}

/** 由真实交接回执提交激活事实；重复投递持有文本时沿用原生命周期起点。 */
export function deliveredEntry(entry: RuleEntry, previousValue: unknown, policy: ReturnType<typeof entryPolicy>, text: string, { turnId, turn, now = Date.now() }: EntryMoment): ActionState {
  const previous = readActionState(previousValue) ?? {}
  const old = policy.reuse ? Materialization.parse(previous.materialization) : undefined
  const stickyUntilTurn = entry.stickyTurns && policy.matches ? turn + entry.stickyTurns : old?.stickyUntilTurn ?? null
  return { ...previous, lastStarted: now, ...(policy.reuse ? {} : { lastActivationAt: now }), turnId,
    materialization: { text, turnId: old?.turnId ?? turnId, turn: old?.turn ?? turn, stickyUntilTurn } }
}
export function deactivatedEntry(previous: unknown, now = Date.now()): ActionState {
  const { materialization, ...remaining } = readActionState(previous) ?? {}
  void materialization
  return { ...remaining, lastInactiveAt: now }
}
