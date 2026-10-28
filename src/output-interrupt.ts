import type { MessageView } from './event-context.js'
import type { CandidateValue } from './event-state.js'
import { deliveryAction } from './event-rules.js'
export interface OutputEvidence { attemptId: string; index: number }
interface Runtime<Message extends MessageView> {
  snapshot(id: string): { candidates: CandidateValue[] }
  collect(input: { sessionId: string; visible: readonly MessageView[]; candidateIds: string[] }): Promise<Message[]>
  filterMessages(id: string, visible: readonly MessageView[], messages: NoInfer<Message>[]): Promise<NoInfer<Message>[]>
  rollback(id: string, messages: NoInfer<Message>[]): Promise<void>
}
interface InterruptOptions<Agent, Message extends MessageView> {
  runtime: Runtime<Message>
  maxInterrupts: number
  sessionId: (agent: Agent) => string
  prepareHumanTurn?: (agent: Agent) => Promise<void>
  humanTurn: (agent: Agent) => string | undefined
  visible: (agent: Agent) => readonly MessageView[]
  isCurrent: (agent: Agent, output: OutputEvidence) => boolean
  cancel: (agent: Agent) => void
  steer: (agent: Agent, message: NoInfer<Message>) => void
}

/** Reuse reserved reminder messages for cancel/steer, with one budget across automatic resumptions. */
export function createOutputInterrupt<Agent, Message extends MessageView>(options: InterruptOptions<Agent, Message>) {
  const budgets = new Map<string, { turn: string; count: number }>()
  const running = new Set<string>()
  return async (agent: Agent, output: OutputEvidence) => {
    const id = options.sessionId(agent)
    if (running.has(id) || options.maxInterrupts === 0 || !options.isCurrent(agent, output)) return
    const ids = options.runtime.snapshot(id).candidates.filter(candidate => candidate.status === 'pending'
      && candidate.output?.attemptId === output.attemptId && candidate.output.index === output.index
      && !deliveryAction(candidate.rule, candidate.actionId).deny
      && candidate.stage === 'assistant.output'
      && deliveryAction(candidate.rule, candidate.actionId).delivery.model.interrupt === 'abort-resume').map(candidate => candidate.id)
    if (!ids.length) return
    running.add(id)
    try {
      // Cold history reads can yield; reserve this interrupt lane before loading it.
      await options.prepareHumanTurn?.(agent)
      const turn = options.humanTurn(agent)
      if (turn === undefined || !options.isCurrent(agent, output)) return
      const previous = budgets.get(id)
      const budget = previous?.turn === turn ? previous : { turn, count: 0 }
      if (budget.count >= options.maxInterrupts) return
      const messages = await options.runtime.collect({ sessionId: id, visible: options.visible(agent), candidateIds: ids })
      const allowed = options.isCurrent(agent, output)
        ? await options.runtime.filterMessages(id, options.visible(agent), messages) : []
      const denied = messages.filter(message => !allowed.includes(message))
      if (denied.length) await options.runtime.rollback(id, denied)
      if (!allowed.length) return
      // Identity lookup and rollback can yield to a new attempt; check the stream after both.
      const latest = await options.runtime.filterMessages(id, options.visible(agent), allowed)
      if (!options.isCurrent(agent, output) || options.humanTurn(agent) !== turn || latest.length !== allowed.length) {
        await options.runtime.rollback(id, allowed)
        return
      }
      // No await separates the last stream check from cancel/steer.
      budget.count++; budgets.set(id, budget)
      try { options.cancel(agent) }
      catch (error) { await options.runtime.rollback(id, allowed); throw error }
      for (const message of allowed) options.steer(agent, message)
      // A throwing steer has an unknown handoff: its durable reservation remains occupied.
    } finally { running.delete(id) }
  }
}
