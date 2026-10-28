import { z } from 'zod'
import { actionKey } from './runtime-policy.js'
import { localWindow } from './event-context.js'
import { triggerKey, type HandoffRule, type OutputHandoffRule, type StateValue, type StickyStateValue } from './event-state.js'
import { recordedDelivery, recordedDeliveryStage } from './recorded-delivery.js'
import type { EventDeliveryState } from './delivery-facts.js'

export interface DeliveryFactMessage { id: string; source: { kind: string; reminder?: { handoff?: { queued?: true }; sessionId?: string } } }
const KIND = 'plugin:dsh-context-care:reminder'
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const Delivery = z.object({ id: z.string(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  source: z.object({ kind: z.literal(KIND), summary: z.string(),
    reminder: z.object({ key: z.string(), candidateId: z.string(), sessionId: z.string().optional(), humanId: z.string().optional(), handoff: z.object({ actionId: z.string().optional(), stage: z.string().optional(), activatedAt: z.number().finite().optional() }).optional(),
      window: z.object({ id: z.string(), start: z.number(), end: z.number() }).optional(),
      shared: z.object({ key: z.string(), until: z.number().optional() }).nullable().optional() }),
    contextCareTrace: z.object({ sourceId: z.string(), ruleId: z.string(), rule: z.unknown(),
      evidence: z.object({ activationId: z.string().optional(),
        event: z.object({ clock: z.object({ at: z.number() }).optional() }).optional(),
        clock: z.object({ at: z.number() }).optional() }).passthrough() }) }) })
const Trigger = z.object({ source: z.object({ kind: z.literal(KIND),
  reminder: z.object({ sessionId: z.string().optional(), handoff: z.object({ actionId: z.string().optional(), stage: z.string().optional(), activatedAt: z.number().finite().optional() }).optional() }),
  // Dedup needs only the recorded trigger kind, not today's validation of an old rule.
  contextCareTrace: z.object({ callId: z.string().optional(), rule: z.unknown().optional(),
    sourceId: z.string().optional(), ruleId: z.string().optional(), output: z.object({ attemptId: z.string(), turn: z.number(), step: z.number() }).optional() }),
}) })
type Activation = { value: StickyStateValue; deliveredStep: number }
export interface DeliveryProjection<Message extends DeliveryFactMessage> {
  cursor: number
  step: number
  openStep: boolean
  humanStep: number
  humanId: string
  humanArrival: string
  humanCommit: string
  inheritedEnd: number
  windows: Map<string, StateValue['windows'][number]>
  stickies: Map<string, Activation>
  toolCalls: Map<string, string>
  committed: Set<string>
  actionStarts: Map<string, number>
  handedEvents: Map<string, number>
  handedRules: Map<string, number>
  handedOutputs: Map<string, number>
  handedChoices: Map<string, number>
  outputCutoffs: Map<string, number>
  inbox: Record<'next-turn' | 'next-step', Message[]>
  queued: Map<string, Message>
}

/** Minimal inbox fold shared by full recovery and the lightweight queued view. */
export type QueuedDeliveryProjection<Message extends DeliveryFactMessage> = Pick<DeliveryProjection<Message>, 'cursor' | 'inheritedEnd' | 'inbox' | 'queued'>
export type QueuedDeliveryFact<Message extends DeliveryFactMessage> = Extract<DeliveryFactEvent<Message>, { type: 'agent/inbox/spliced' | 'user/message' }>
export function emptyQueuedDeliveryProjection<Message extends DeliveryFactMessage>(inheritedEnd: number): QueuedDeliveryProjection<Message> {
  return { cursor: 0, inheritedEnd, inbox: { 'next-turn': [], 'next-step': [] }, queued: new Map() }
}
export function applyQueuedDeliveryFact<Message extends DeliveryFactMessage>(projection: QueuedDeliveryProjection<Message>, sessionId: string, event: QueuedDeliveryFact<Message>): void {
  if (event.seq < projection.cursor) return
  projection.cursor = event.seq + 1
  if (event.type === 'user/message') { projection.queued.delete(String(event.data.id)); return }
  const splice = event.data
  const removed = projection.inbox[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  if (splice.outcome === 'canceled') for (const message of removed) projection.queued.delete(String(message.id))
  if (event.seq >= projection.inheritedEnd) for (const message of splice.inserted) {
    if (isQueuedDelivery(sessionId, message)) projection.queued.set(String(message.id), message)
  }
}
export function isQueuedDelivery(sessionId: string, message: DeliveryFactMessage): boolean {
  return message.source.kind === KIND && message.source.reminder?.handoff?.queued === true && message.source.reminder.sessionId === sessionId
}
export function queuedDeliveryMessages<Message extends DeliveryFactMessage>(sessionId: string, accepted: ReadonlyMap<string, Message> | undefined, inbox: readonly Message[]): Message[] {
  const messages = new Map(accepted)
  for (const message of inbox) if (isQueuedDelivery(sessionId, message)) messages.set(String(message.id), message)
  return structuredClone([...messages.values()])
}

export function emptyDeliveryProjection<Message extends DeliveryFactMessage>(inheritedEnd: number): DeliveryProjection<Message> {
  return { cursor: 0, step: -1, openStep: false, humanStep: -1, humanId: '', humanArrival: '', humanCommit: '', inheritedEnd,
    windows: new Map(), stickies: new Map(), toolCalls: new Map(), committed: new Set(), actionStarts: new Map(), handedEvents: new Map(),
    handedRules: new Map(), handedOutputs: new Map(), handedChoices: new Map(), outputCutoffs: new Map(),
    inbox: { 'next-turn': [], 'next-step': [] }, queued: new Map() }
}

/** A clock spends cooldown only after its final delivery has actually committed. */
function tick<Message extends DeliveryFactMessage>(projection: DeliveryProjection<Message>, clock: StickyStateValue['clock'], humanId?: string) {
  for (const [id, activation] of projection.stickies) {
    const value = activation.value
    if (value.clock !== clock || (clock === 'human-turn' && value.lastHumanId === humanId)) continue
    if (humanId !== undefined) value.lastHumanId = humanId
    // A queued reminder can precede the human input in the same committed batch.
    // That input belongs to its delivery request, not to a later cooldown turn.
    if (value.remaining === 0 && (clock !== 'human-turn' || activation.deliveredStep !== projection.step)) {
      if (value.cooldown === 0) projection.stickies.delete(id)
      else value.cooldown -= 1
    }
  }
}

/**
 * A snooze is a committed tool result. Its JSON body carries the exact window
 * selected by that invocation, so replay never re-runs current rule selection.
 */
function applySnooze<Message extends DeliveryFactMessage>(projection: DeliveryProjection<Message>, sessionId: string, content: unknown, meta: unknown, ports: DeliveryFoldPorts) {
  const result = ports.readSnooze(Array.isArray(content) ? content : [], meta)
  if (!result || result.sessionId !== sessionId) return
  for (const window of result.windows) {
    projection.windows.set(window.key, { key: window.key, until: window.until })
  }
}

function outputRuleKey(rule: OutputHandoffRule): string {
  return JSON.stringify([rule.output.attemptId, rule.sourceId, rule.ruleId, rule.actionId ?? 'model'])
}
function outputStepKey(rule: OutputHandoffRule): string {
  return JSON.stringify([rule.output.turn, rule.output.step, rule.sourceId, rule.ruleId, rule.actionId ?? 'model'])
}
function handoffRuleKey(eventId: string, rule: Pick<HandoffRule, 'sourceId' | 'ruleId' | 'actionId'>): string {
  return JSON.stringify([eventId, rule.sourceId, rule.ruleId, rule.actionId ?? 'model'])
}
function outputChoiceKey(eventId: string, group: string): string {
  return JSON.stringify([eventId, group])
}
export function deliveryHanded<Message extends DeliveryFactMessage>(state: DeliveryProjection<Message>, sessionId: string, eventId: string, rule?: HandoffRule, fromSeq = 0): boolean {
  const accepted = (seq: number | undefined) => seq !== undefined && seq >= fromSeq
  if (!rule) return accepted(state.handedEvents.get(eventId))
  if (accepted(state.handedRules.get(handoffRuleKey(eventId, rule)))) return true
  if (rule.exclusiveGroup && accepted(state.handedChoices.get(outputChoiceKey(eventId, rule.exclusiveGroup)))) return true
  if (!rule.output) return false
  const outputRule: OutputHandoffRule = { ...rule, output: rule.output }
  if (accepted(state.handedOutputs.get(outputRuleKey(outputRule)))) return true
  const prefix = `session:${sessionId}:output:`, attempt = outputRule.output.attemptId
  if (!attempt.startsWith(prefix)) return false
  const boundary = Number(attempt.slice(prefix.length)), cutoff = state.outputCutoffs.get(outputStepKey(outputRule))
  return Number.isSafeInteger(boundary) && boundary >= 0 && cutoff !== undefined && cutoff - 1 >= fromSeq && boundary < cutoff
}

/** A real inbox acceptance or message commit establishes this trigger's completed match. */
export function rememberDeliveryTrigger<Message extends DeliveryFactMessage>(projection: DeliveryProjection<Message>, sessionId: string, value: unknown) {
  if (!record(value) || !record(value.source) || value.source.kind !== KIND) return
  const source = Trigger.parse(value).source
  if (source.reminder.sessionId !== undefined && source.reminder.sessionId !== sessionId) return
  const { callId, rule, sourceId, ruleId, output } = source.contextCareTrace
  const actionId = source.reminder.handoff?.actionId ?? 'model'
  const type = source.reminder.handoff?.stage ?? recordedDeliveryStage(rule, actionId)
  const at = source.reminder.handoff?.activatedAt
  if (at !== undefined && sourceId !== undefined && ruleId !== undefined && record(rule) && typeof rule.revision === 'number') {
    const key = actionKey({ sourceId, ruleId, ruleRevision: rule.revision }, { id: actionId })
    projection.actionStarts.set(key, Math.max(projection.actionStarts.get(key) ?? Number.NEGATIVE_INFINITY, at))
  }
  // Each rule owns its handoff. A shared native event id must not suppress
  // another rule whose candidate has not entered the inbox or Session yet.
  if (callId !== undefined) {
    const eventId = triggerKey(type, callId)
    if (sourceId !== undefined && ruleId !== undefined) {
      const key = handoffRuleKey(eventId, { sourceId, ruleId, actionId })
      projection.handedRules.set(key, Math.max(projection.handedRules.get(key) ?? -1, projection.cursor - 1))
    } else if (type !== 'assistant.output') projection.handedEvents.set(eventId, Math.max(projection.handedEvents.get(eventId) ?? -1, projection.cursor - 1))
    if (record(rule) && typeof rule.exclusiveGroup === 'string') {
      const key = outputChoiceKey(eventId, rule.exclusiveGroup)
      projection.handedChoices.set(key, Math.max(projection.handedChoices.get(key) ?? -1, projection.cursor - 1))
    }
  }
  // A natural boundary coalesces an output rule's pending prefixes from one
  // attempt. Later retries in the same step retain their own native identities.
  if (type === 'assistant.output' && sourceId !== undefined && ruleId !== undefined && output !== undefined) {
    const handed = { sourceId, ruleId, actionId, output }
    const key = outputRuleKey(handed)
    projection.handedOutputs.set(key, Math.max(projection.handedOutputs.get(key) ?? -1, projection.cursor - 1))
    // A handed message consumes pending prefixes from attempts already started
    // in that native step. The cursor also covers older lifecycle-local attempt
    // ids without mistaking a later retry for an already delivered observation.
    const stepKey = outputStepKey(handed)
    projection.outputCutoffs.set(stepKey, Math.max(projection.outputCutoffs.get(stepKey) ?? 0, projection.cursor))
  }
}

/** Native message commits, not visibility after compaction, establish delivery. */
export function applyDeliveryFact<Message extends DeliveryFactMessage>(projection: DeliveryProjection<Message>, sessionId: string, event: DeliveryFactEvent<Message>, ports: DeliveryFoldPorts) {
  if (event.seq < projection.cursor) return
  if (event.type === 'agent/inbox/spliced' || event.type === 'user/message') applyQueuedDeliveryFact(projection, sessionId, event)
  else projection.cursor = event.seq + 1
  if (event.type === 'agent/inbox/spliced') {
    const splice = event.data
    if (event.seq >= projection.inheritedEnd) {
      for (const message of splice.inserted) {
        rememberDeliveryTrigger(projection, sessionId, message)
      }
      if (splice.inserted.some(message => message.source.kind === 'user')) projection.humanArrival = String(event.seq)
    }
    return
  }
  if (event.type === 'user/message' && event.seq >= projection.inheritedEnd && event.data.source.kind === 'user') {
    projection.humanCommit = String(event.seq)
  }
  if (event.type === 'step/start') {
    projection.step = event.seq
    projection.openStep = true
    tick(projection, 'main-request')
    return
  }
  if (event.type === 'step/end' || event.type === 'turn/start' || event.type === 'turn/end') {
    projection.openStep = false
    return
  }
  if (event.type === 'tool/call') {
    const data: unknown = event.data
    if (record(data) && typeof data.callId === 'string' && typeof data.name === 'string') {
      projection.toolCalls.set(data.callId, data.name)
    }
    return
  }
  if (event.type === 'tool/ptc-dispatch') {
    const data: unknown = event.data
    if (record(data) && data.name === ports.snoozeTool && data.isError !== true) {
      applySnooze(projection, sessionId, data.content, data.meta, ports)
    }
    return
  }
  if (event.type === 'tool/result') {
    const data: unknown = event.data
    const message = record(data) && record(data.message) ? data.message : undefined
    if (!message || message.isError === true) return
    const source = record(message.source) ? message.source : undefined
    const meta = record(data) ? data.meta : undefined
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId
      : source && typeof source.callId === 'string' ? source.callId : undefined
    const name = callId === undefined ? undefined : projection.toolCalls.get(callId)
    if (name === ports.snoozeTool) applySnooze(projection, sessionId, message.content, meta, ports)
    if (callId !== undefined) projection.toolCalls.delete(callId)
    return
  }
  if (event.type !== 'user/message' || projection.committed.has(String(event.data.id))) return
  projection.committed.add(String(event.data.id))
  if (event.seq >= projection.inheritedEnd) rememberDeliveryTrigger(projection, sessionId, event.data)
  if (event.data.source.kind === 'user') {
    projection.humanId = String(event.data.id)
    if (!projection.openStep || projection.humanStep !== projection.step) tick(projection, 'human-turn', projection.humanId)
    else for (const { value } of projection.stickies.values()) {
      if (value.clock === 'human-turn') value.lastHumanId = projection.humanId
    }
    projection.humanStep = projection.step
    return
  }
  if (event.data.source.kind !== KIND) return
  const message = Delivery.parse(event.data)
  // A fork inherits readable context, not its parent's local activation counters.
  if (event.seq < projection.inheritedEnd || (message.source.reminder.sessionId !== undefined
    && message.source.reminder.sessionId !== sessionId)) return
  const { reminder, contextCareTrace: trace } = message.source
  const actionId = reminder.handoff?.actionId ?? 'model'
  const { model, timeWindow } = recordedDelivery(trace.rule, actionId)
  if (model.once === 'window') {
    let window = reminder.window
    if (!window) {
      // 早期 request.before 把触发时钟直接记在 evidence.clock；它同样是原生投递事实。
      const at = trace.evidence.event?.clock?.at ?? trace.evidence.clock?.at
      if (at === undefined || !timeWindow) throw new Error('reminder-delivery-window-evidence-missing')
      window = localWindow(timeWindow, at)
      if (!window || reminder.key !== JSON.stringify([trace.sourceId, trace.ruleId, actionId, window.id])) {
        throw new Error('reminder-delivery-window-evidence-mismatch')
      }
    }
    projection.windows.set(reminder.key, { key: reminder.key, until: window.end, messageId: message.id })
  }
  const parent = trace.evidence.activationId
  if (parent !== undefined) {
    const activation = projection.stickies.get(parent)
    if (activation) {
      activation.value.remaining = Math.max(0, activation.value.remaining - 1)
      activation.deliveredStep = projection.step
      activation.value.lastHumanId = projection.humanId
    }
  } else if (model.sticky) {
    projection.stickies.set(reminder.candidateId, { deliveredStep: projection.step, value: {
      key: JSON.stringify([trace.sourceId, trace.ruleId, reminder.candidateId]), activationId: reminder.candidateId,
      sourceId: trace.sourceId, ruleId: trace.ruleId, actionId, sessionId,
      text: message.content.map(block => block.text).join(''), title: message.source.summary,
      clock: model.sticky.clock, remaining: model.sticky.lifetime - 1, cooldown: model.sticky.cooldown,
      charged: reminder.shared === undefined ? model.shared !== undefined : reminder.shared !== null,
      lastHumanId: projection.humanId,
    } })
  }
}

export interface DeliveryFoldPorts { snoozeTool: string; readSnooze(content: readonly unknown[], meta: unknown): { sessionId: string; windows: { key: string; until: number }[] } | undefined }
export type DeliveryFactEvent<Message extends DeliveryFactMessage> =
  | { type: 'agent/inbox/spliced'; seq: number; data: { target: 'next-turn' | 'next-step'; start: number; removedCount?: number; inserted: Message[]; outcome?: string } }
  | { type: 'user/message'; seq: number; data: Message }
  | { type: 'step/start' | 'step/end' | 'turn/start' | 'turn/end' | 'tool/call' | 'tool/result' | 'tool/ptc-dispatch'; seq: number; data: unknown }
/** Preview the next admission without spending a committed clock tick. */
export function readDeliveryProjection<Message extends DeliveryFactMessage>(state: DeliveryProjection<Message>, currentHumanId: string, now: number): Omit<EventDeliveryState, 'queued'> & { queued: Message[] } {
  const humanId = currentHumanId && !state.committed.has(currentHumanId) ? currentHumanId : state.humanId
  const stickies: StickyStateValue[] = [], ticked = new Set<string>()
  for (const activation of state.stickies.values()) {
    const value = structuredClone(activation.value)
    if (value.clock === 'main-request' && !state.openStep) {
      if (value.remaining > 0) ticked.add(value.activationId)
      else if (value.cooldown === 0) continue
      else value.cooldown -= 1
    } else if (value.clock === 'human-turn' && value.lastHumanId !== humanId) {
      value.lastHumanId = humanId
      if (value.remaining > 0) ticked.add(value.activationId)
      else if (value.cooldown === 0) continue
      else value.cooldown -= 1
    }
    stickies.push(value)
  }
  for (const [key, window] of state.windows) if (window.until <= now) state.windows.delete(key)
  return { actionStarts: state.actionStarts, windows: [...state.windows.values()], stickies, ticked, committedIds: state.committed, humanId, queued: structuredClone([...state.queued.values()]) }
}
