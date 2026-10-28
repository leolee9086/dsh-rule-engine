/** 提醒与清理的处置策略；原生读取只需交出命中、执行者可用性和最近消息事实。 */
export function loopNeedsReminder(hit: { severity?: string } | undefined, cleanupActive: boolean): boolean {
  if (hit === undefined) return false
  return hit.severity === 'mild' || cleanupActive !== true
}

/** 相同的模型可见状态文本无需重复投递；数值元数据变化本身不形成新提醒。 */
export function shouldNotify(previous: { text?: string } | undefined, text: string, _state?: unknown): boolean {
  return previous?.text !== text
}

export interface StreamNoticeInput<A> { agent: A; trigger: { id: string }; hit: { [key: string]: unknown } }
export interface StreamNoticePorts<A> {
  key(agent: A): string
  epoch(agent: A, trigger: { id: string }): unknown
  enabled(agent: A, trigger: { id: string }, action: string): boolean
  available(trigger: { id: string }): boolean
  notice(input: StreamNoticeInput<A>): unknown
  abort(input: StreamNoticeInput<A>): unknown
  resume(input: StreamNoticeInput<A> & { includeNotice: boolean }): unknown
  maxAutoResume?: number
}
/** 库统一决定执行哪些流式动作；端口只执行原生动作及文案呈现。 */
export function createStreamNoticeActions<A>(ports: StreamNoticePorts<A>) {
  const policy = createStreamNoticePolicy({ maxAutoResume: ports.maxAutoResume })
  return {
    humanInput(agent: A) { policy.humanInput(ports.key(agent)) },
    actions: {
      notice(input: StreamNoticeInput<A>) {
        const { agent, trigger } = input
        if (!ports.available(trigger) || !policy.notice(ports.key(agent), trigger.id, ports.epoch(agent, trigger), ports.enabled(agent, trigger, 'resume'))) return
        ports.notice(input)
      },
      abort(input: StreamNoticeInput<A>) {
        ports.abort(input)
        policy.aborted(ports.key(input.agent))
      },
      resume(input: StreamNoticeInput<A>) {
        if (!policy.resume(ports.key(input.agent))) return false
        if (!ports.available(input.trigger)) return undefined
        return ports.resume({ ...input, includeNotice: ports.enabled(input.agent, input.trigger, 'notice') })
      },
    },
  }
}

/** 流式动作共享提醒去重和续接额度；Host 仅执行注入、取消及 steer。 */
export function createStreamNoticePolicy({ maxAutoResume = 1 }: { maxAutoResume?: number } = {}) {
  const abortCounts = new Map<string, number>(), noticeSent = new Set<string>()
  return {
    notice(agentId: string, triggerId: string, epoch: unknown, resumeEnabled: boolean): boolean {
      if (triggerId === 'line-repeat' && resumeEnabled && (abortCounts.get(agentId) ?? 0) < maxAutoResume) return false
      const key = `${agentId}:${triggerId}:${epoch}`
      if (noticeSent.has(key)) return false
      noticeSent.add(key)
      return true
    },
    aborted(agentId: string) { abortCounts.set(agentId, (abortCounts.get(agentId) ?? 0) + 1) },
    resume(agentId: string): boolean { return (abortCounts.get(agentId) ?? 0) <= maxAutoResume },
    humanInput(agentId: string) {
      const prefix = `${agentId}:`
      for (const key of noticeSent) if (key.startsWith(prefix)) noticeSent.delete(key)
    },
  }
}
