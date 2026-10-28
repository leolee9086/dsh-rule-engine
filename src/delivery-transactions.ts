import type { MessageView } from './event-context.js'
import type { CollectInput, RequestInput } from './event-state.js'

interface DeliveryFilter {
  filterMessages<Message extends MessageView>(sessionId: string, visible: readonly MessageView[], messages: Message[], agentPreset?: string, queued?: boolean): Promise<Message[]>
  rollback(sessionId: string, messages: MessageView[]): Promise<void>
}
interface QueuedDelivery<Message extends MessageView> extends DeliveryFilter {
  queuePending(input: CollectInput): Promise<Message[]>
}
interface DeliveryCollection<Message extends MessageView> {
  prepareRequest?(input: RequestInput): Promise<void>
  collect(input: CollectInput): Promise<Message[]>
}

/** Replace frozen queued inputs in place; ordinary inputs retain identity and order. */
export function planDeliveryInputs<Message extends MessageView>(accepted: readonly Message[], collected: readonly Message[] = []): Message[] {
  const replacements = new Map(collected.map(message => [message.id, message]))
  const messages = accepted.flatMap(message => {
    const replacement = replacements.get(message.id)
    if (replacement) { replacements.delete(message.id); return [replacement] }
    return message.source?.kind === 'plugin:dsh-context-care:reminder' && message.source.reminder?.handoff?.queued ? [] : [message]
  })
  return [...messages, ...replacements.values()]
}

/** Natural-request preparation and input reconciliation share one engine policy. */
export async function collectDeliveryInputs<Message extends MessageView>(runtime: DeliveryCollection<Message>, input: RequestInput & { accepted: Message[] }): Promise<Message[]> {
  await runtime.prepareRequest?.(input)
  return planDeliveryInputs(input.accepted, await runtime.collect({ ...input, visible: input.visible ?? [] }))
}

export interface DeliveryFilterOptions<Message extends MessageView> {
  runtime: DeliveryFilter
  sessionId: string
  messages: Message[]
  visible(): readonly MessageView[]
  onRollbackError?: (error: unknown) => void
}
/** A rollback yields to policy changes; repeat until the final check can hand off directly. */
export interface DeliveryCommitOptions<Message extends MessageView, Result> extends DeliveryFilterOptions<Message> {
  /** Runs synchronously beside the final validation, before returning across another await. */
  commit(messages: Message[]): Result
}
export function filterDeliveryMessages<Message extends MessageView, Result>(options: DeliveryCommitOptions<Message, Result>): Promise<Result>
export function filterDeliveryMessages<Message extends MessageView>(options: DeliveryFilterOptions<Message>): Promise<Message[]>
export async function filterDeliveryMessages<Message extends MessageView, Result>(options: DeliveryFilterOptions<Message> | DeliveryCommitOptions<Message, Result>): Promise<Message[] | Result> {
  let messages = options.messages
  for (;;) {
    const filtered = await options.runtime.filterMessages(options.sessionId, options.visible(), messages)
    const denied = messages.filter(message => !filtered.includes(message))
    messages = filtered
    if (!denied.length) return 'commit' in options ? options.commit(messages) : messages
    try { await options.runtime.rollback(options.sessionId, denied) }
    catch (error) {
      if (!options.onRollbackError) throw error
      options.onRollbackError(error)
    }
  }
}

export interface QueuedHandoffOptions<Message extends MessageView> {
  runtime: QueuedDelivery<Message>
  sessionId: string
  candidateIds: readonly string[]
  visible(): readonly MessageView[]
  publish(message: Message): void
}
/** Freeze pending matches and recheck after rollback/identity I/O before synchronous publication. */
export async function handoffQueuedDelivery<Message extends MessageView>(options: QueuedHandoffOptions<Message>): Promise<void> {
  const { runtime, sessionId } = options
  const visible = options.visible()
  const messages = await runtime.queuePending({ sessionId, visible, candidateIds: [...options.candidateIds] })
  const allowed = await runtime.filterMessages(sessionId, visible, messages, undefined, true)
  const denied = messages.filter(message => !allowed.includes(message))
  if (denied.length) await runtime.rollback(sessionId, denied)
  if (!allowed.length) return
  const latest = await runtime.filterMessages(sessionId, options.visible(), allowed, undefined, true)
  if (latest.length !== allowed.length) { await runtime.rollback(sessionId, allowed); return }
  // Keep publication adjacent to the final synchronous decision, with no await in the loop.
  for (const message of latest) options.publish(message)
}
