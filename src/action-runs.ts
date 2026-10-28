import { randomUUID } from 'node:crypto'
import { bindInputs, type RuleEvent, type V2Action } from './block-rules.js'
import { createActionCapacity, awaitApproval } from './action-capacity.js'
import { RuleStateError } from './declarations.js'
import { isRecord } from './guard.js'
import { actionRunRecords } from './run-records.js'
import type { RuleStore } from './rule-store.js'
import type { ActionRunRecord, ActionWorkItem, EngineRuntime } from './runtime-types.js'
import type { PlanningDecision, PlanningSnapshot, PlanningTemplates } from './planning-types.js'

export const compactExecutorRef = 'context-care:compact'
const terminal = new Set(['succeeded', 'failed', 'skipped', 'cancelled', 'unknown'])
const externalAction = (action: V2Action) => ['program', 'tool', 'job', 'compact'].includes(action.kind)
export interface ActionExecutor<A> {
  timeoutMs: number
  requiresApproval: boolean
  toolName: string
  validate(inputs: unknown): boolean
  errors?(): unknown
  run(input: { agent: A; inputs: unknown; signal: AbortSignal; runId: string }): Promise<unknown>
}
export interface ActionRunPorts<A> {
  sessionId(agent: A): string
  approve?(agent: A, request: { toolName: string; reason: string; signal: AbortSignal }): unknown | Promise<unknown>
  abort(agent: A, reason: string): void
  resume(agent: A, text: string): void
  deliver(agent: A, text: string | undefined): void
}
export interface ActionRunOptions<A> {
  store: RuleStore
  registry: { get(ref?: string): ActionExecutor<A> | undefined }
  guard(sessionId: string, event: RuleEvent, action: V2Action, token?: string, options?: { dispatchId?: string; delivery?: boolean }): PlanningDecision
  templates: PlanningTemplates
  setVariable?(agent: A, item: ActionWorkItem, value: unknown, context: PlanningSnapshot): Promise<{ token: string; vars: unknown }>
  ports: ActionRunPorts<A>
  maxQueued?: number
  maxConcurrent?: number
  report?(error: unknown): void
  secondaryFailure?(error: unknown, secondary: unknown, phase: string): void
  now?(): number
}
type Queued = ActionWorkItem & { run: ActionRunRecord }
const keyOf = (item: ActionWorkItem) => JSON.stringify([item.event.sourceId, item.event.ruleId, item.event.ruleRevision, item.action.id])
function requireRun(runtime: EngineRuntime, id: string) {
  const run = actionRunRecords(runtime).find(value => value.id === id)
  if (!run) throw new Error('action-run-unavailable')
  return run
}

/** 动作接纳、串行 drain、依赖与冷却结算由引擎持有，端口只执行实际宿主操作。 */
export function createActionRuns<A>({ store, registry, guard, templates, setVariable, ports, maxQueued = 128, maxConcurrent = 8,
  report = () => {}, secondaryFailure = (error, secondary) => { report(new AggregateError([error, secondary], 'action-failure-ledger')) }, now = () => Date.now() }: ActionRunOptions<A>) {
  const pending = new Map<string, Queued[]>(), running = new Map<string, { controller: AbortController; sessionId: string }>()
  const draining = new Map<string, Promise<void>>(), enqueuing = new Set<Promise<string[]>>()
  const acquire = createActionCapacity(maxConcurrent)
  let closed = false, closing: Promise<void> | undefined
  async function state(sessionId: string, id: string, update: Partial<ActionRunRecord>) {
    await store.runtime(sessionId, runtime => { Object.assign(requireRun(runtime, id), update, { updatedAt: now() }) })
  }
  return {
    async recover() {
      for (const id of store.sessions()) {
        const stale = actionRunRecords(store.read(id).runtime).filter(run => !terminal.has(run.status))
        if (stale.length) await store.runtime(id, runtime => {
          for (const run of actionRunRecords(runtime).filter(run => stale.some(item => item.id === run.id))) {
            if (run.status === 'running' && ['notify', 'guidance', 'inject'].includes(run.kind ?? '')) run.delivery = 'unknown'
            run.status = run.status === 'running' ? 'unknown' : 'skipped'
            run.reason = 'host-restarted'; run.updatedAt = now()
          }
        })
      }
    },
    enqueue(sessionId: string, items: readonly ActionWorkItem[], token: string): Promise<string[]> {
      if (closed) return Promise.reject(new Error('action-runs-closed'))
      if (!items.length) return Promise.resolve([])
      const operation = (async () => {
        const queue = pending.get(sessionId) ?? []; pending.set(sessionId, queue)
        const accepted: Queued[] = []
        await store.runtime(sessionId, runtime => {
          if (closed) throw new Error('action-runs-closed')
          const queued = actionRunRecords(runtime).filter(run => !terminal.has(run.status)).length
          let newlyQueued = 0
          for (const item of items) {
            const gate = guard(sessionId, item.event, item.action, token, { dispatchId: item.dispatchId }), key = keyOf(item)
            if (actionRunRecords(runtime).some(run => run.occurrenceId === item.event.occurrenceId && run.key === key)) continue
            const run: ActionRunRecord = { id: randomUUID(), sessionId, key, occurrenceId: item.event.occurrenceId, sourceId: item.event.sourceId, ruleId: item.event.ruleId,
              ruleRevision: item.event.ruleRevision, actionId: item.action.id, executorRef: item.action.kind === 'compact' ? compactExecutorRef : item.action.executorRef ?? null,
              kind: item.action.kind, turnId: item.context.session.turnId, failurePolicy: item.action.failurePolicy ?? 'skip-dependents',
              status: gate.enabled ? 'queued' : 'skipped', reason: gate.enabled ? null : gate.reason, createdAt: now(), updatedAt: now(), inputs: item.inputs ?? null, sourceSeqs: item.event.sourceSeqs,
              ...(item.event.triggerSeq === undefined ? {} : { triggerSeq: item.event.triggerSeq }), controlToken: token, delivery: 'not-delivered' }
            if (gate.enabled && queued + ++newlyQueued > maxQueued) throw new Error('action-queue-budget-exceeded')
            runtime.runs.push(run); if (gate.enabled) accepted.push({ ...item, run, token })
          }
        })
        if (closed) { for (const item of accepted) await state(sessionId, item.run.id, { status: 'skipped', reason: 'host-closed' }); return [] }
        const eligible = accepted.filter(item => actionRunRecords(store.read(sessionId).runtime).find(run => run.id === item.run.id)?.status === 'queued')
        queue.push(...eligible); pending.set(sessionId, queue)
        return eligible.map(item => item.run.id)
      })()
      enqueuing.add(operation)
      const release = () => enqueuing.delete(operation)
      operation.then(release, release)
      return operation
    },
    async drain(agent: A, signal?: AbortSignal) {
      const sessionId = ports.sessionId(agent)
      const previous = draining.get(sessionId)
      if (previous) return previous
      const operation = (async () => {
        const queue = pending.get(sessionId) ?? []
        while (queue.length && !closed) {
          const item = queue.shift()
          if (!item) break
          const { run, action, event } = item
          if (actionRunRecords(store.read(sessionId).runtime).find(value => value.id === run.id)?.status !== 'queued') continue
          if (signal?.aborted && action.kind !== 'resume') { await state(sessionId, run.id, { status: 'cancelled', reason: 'turn-cancelled-before-start' }); continue }
          let gate = guard(sessionId, event, action, item.token, { dispatchId: item.dispatchId })
          if (!gate.enabled) { await state(sessionId, run.id, { status: 'skipped', reason: gate.reason }); continue }
          const dependencies = actionRunRecords(store.read(sessionId).runtime).filter(other => other.occurrenceId === event.occurrenceId && other.sourceId === event.sourceId
            && other.ruleId === event.ruleId && other.ruleRevision === event.ruleRevision && action.dependsOn.includes(other.actionId ?? ''))
          if (action.dependsOn.length && (dependencies.length !== action.dependsOn.length || dependencies.some(other => other.status !== 'succeeded'
            && !(other.status === 'failed' && action.failurePolicy === 'continue')))) {
            await state(sessionId, run.id, { status: 'skipped', reason: 'dependency-not-succeeded' }); continue
          }
          const controller = new AbortController(); running.set(run.id, { controller, sessionId })
          let timer: ReturnType<typeof setTimeout> | undefined, started = false, completed = false, deliveryAttempted = false, delivered = false, release: (() => void) | undefined
          const abortTurn = () => { if (action.kind !== 'abort' && action.kind !== 'resume') controller.abort(new Error('turn-cancelled')) }
          signal?.addEventListener('abort', abortTurn, { once: true })
          try {
            const context = { ...item.context, results: Object.fromEntries(dependencies.map(dependency => [dependency.actionId,
              dependency.status === 'succeeded' ? dependency.result?.value : { status: 'failed', reason: dependency.reason }])),
              outcomes: Object.fromEntries(dependencies.map(dependency => [dependency.actionId, { status: dependency.status, reason: dependency.reason ?? null }])) }
            const text = item.templateDeferred && action.template !== undefined ? templates.render(action.template, context) : item.text
            if (text !== undefined && text.length > (action.maxChars ?? 65536)) throw new Error('action-output-budget-exceeded')
            const inputs = action.kind === 'compact' ? { note: text } : item.inputsDeferred && action.inputs !== undefined ? bindInputs(action.inputs, context) : item.inputs
            const executor = externalAction(action) ? registry.get(action.kind === 'compact' ? compactExecutorRef : action.executorRef) : undefined
            if (externalAction(action)) {
              if (!executor) throw new Error('executor-unavailable')
              if (!executor.validate(inputs)) throw new Error(`executor-input-invalid:${JSON.stringify(executor.errors?.())}`)
              timer = setTimeout(() => controller.abort(new Error('action-timeout')), action.timeoutMs ?? executor.timeoutMs)
              release = await acquire(controller.signal)
              if (executor.requiresApproval) {
                if (!ports.approve) throw new Error('approval-unavailable')
                await state(sessionId, run.id, { status: 'waiting-approval' })
                const approval = ports.approve
                const outcome = await awaitApproval(() => approval(agent, { toolName: executor.toolName, reason: `Context rule ${event.sourceId}/${event.ruleId}/${action.id}; inputs ${JSON.stringify(inputs)}`, signal: controller.signal }), controller.signal)
                if (outcome !== 'allowed-once') { await state(sessionId, run.id, { status: outcome === 'cancelled' ? 'cancelled' : 'skipped', reason: `approval-${String(outcome)}` }); continue }
              }
            }
            gate = guard(sessionId, event, action, item.token, { dispatchId: item.dispatchId })
            if (!gate.enabled) { await state(sessionId, run.id, { status: 'skipped', reason: gate.reason }); continue }
            if (controller.signal.aborted) { await state(sessionId, run.id, { status: 'cancelled', reason: 'cancelled-before-start' }); continue }
            await state(sessionId, run.id, { status: 'running', startedAt: now() })
            gate = guard(sessionId, event, action, item.token, { dispatchId: item.dispatchId })
            if (!gate.enabled) { await state(sessionId, run.id, { status: 'skipped', reason: gate.reason }); continue }
            if (controller.signal.aborted || closed) { await state(sessionId, run.id, { status: 'cancelled', reason: 'cancelled-before-start' }); continue }
            started = true
            let result: unknown
            if (externalAction(action)) {
              if (!executor) throw new Error('executor-unavailable')
              result = await executor.run({ agent, inputs, signal: controller.signal, runId: run.id })
            } else if (action.kind === 'set-variable') {
              const value = bindInputs(action.value, context)
              if (setVariable) {
                const previousToken = item.token, updated = await setVariable(agent, item, value, context), renewed = new Set([action.id])
                for (const dependent of queue) {
                  if (dependent.token !== previousToken || dependent.event.occurrenceId !== event.occurrenceId || dependent.event.sourceId !== event.sourceId
                    || dependent.event.ruleId !== event.ruleId || dependent.event.ruleRevision !== event.ruleRevision || !dependent.action.dependsOn.some(id => renewed.has(id))) continue
                  renewed.add(dependent.action.id); dependent.token = updated.token
                  dependent.context = { ...dependent.context, vars: updated.vars }
                  dependent.inputsDeferred = dependent.action.inputs !== undefined; dependent.templateDeferred = dependent.action.template !== undefined
                }
                item.token = updated.token
              } else {
                const declaration = store.read(sessionId).documents.flatMap(document => document.variables).find(variable => variable.name === action.variable)
                if (!declaration) throw new Error('variable-unavailable')
                await store.automaticVariable(sessionId, declaration, value, context.session.turnId)
              }
              result = { value }
            } else if (action.kind === 'abort') {
              ports.abort(agent, `context-rule:${event.sourceId}/${event.ruleId}/${action.id}`); result = { value: 'abort-requested' }
            } else if (action.kind === 'resume') {
              if (typeof text !== 'string' || !text) throw new Error('resume-template-required')
              if (!dependencies.some(dependency => dependency.result?.value === 'abort-requested')) throw new Error('resume-requires-successful-abort')
              ports.resume(agent, text); result = { value: 'resume-queued' }
            } else if (['notify', 'guidance', 'inject'].includes(action.kind)) {
              if (typeof text !== 'string') throw new Error('action-template-required')
              result = { value: text }
            } else throw new Error(`action-unavailable:${action.kind}`)
            if (['notify', 'guidance', 'inject'].includes(action.kind)) {
              const delivery = guard(sessionId, event, action, item.token, { delivery: true, dispatchId: item.dispatchId })
              if (!delivery.enabled || controller.signal.aborted || closed) { await state(sessionId, run.id, { status: 'skipped', reason: delivery.reason ?? 'delivery-cancelled' }); continue }
              deliveryAttempted = true; ports.deliver(agent, text); delivered = true
            }
            completed = true
            const serialized: unknown = JSON.parse(JSON.stringify(result))
            if (!isRecord(serialized)) throw new TypeError('action-result-must-be-object')
            await store.runtime(sessionId, runtime => {
              Object.assign(requireRun(runtime, run.id), { status: controller.signal.aborted ? 'unknown' : 'succeeded', result: serialized,
                finishedAt: now(), updatedAt: now(), delivery: delivered ? 'delivered' : 'not-delivered', reason: controller.signal.aborted ? 'cancel-after-start-outcome-unconfirmed' : null })
              if (!controller.signal.aborted && run.key) runtime.state[run.key] = { lastStarted: now(), occurrenceId: event.occurrenceId, turnId: item.context.session.turnId }
            })
          } catch (error: unknown) {
            report(error)
            const unconfirmed = isRecord(error) && error.outcomeUnconfirmed
            try {
              await store.runtime(sessionId, runtime => { Object.assign(requireRun(runtime, run.id), { status: completed || deliveryAttempted || unconfirmed || controller.signal.aborted && started ? 'unknown'
                : controller.signal.aborted ? 'cancelled' : 'failed', reason: error instanceof Error ? error.message : String(error), finishedAt: now(), updatedAt: now(),
                delivery: delivered ? 'delivered' : deliveryAttempted ? 'unknown' : 'not-delivered' }) })
            } catch (secondary) { secondaryFailure(error, secondary, 'action-failure-ledger'); throw error }
          } finally { clearTimeout(timer); release?.(); signal?.removeEventListener('abort', abortTurn); running.delete(run.id) }
        }
      })()
      draining.set(sessionId, operation)
      try { await operation } finally { draining.delete(sessionId) }
    },
    async cancel(sessionId: string, runId: string) {
      const record = actionRunRecords(store.read(sessionId).runtime).find(run => run.id === runId)
      if (!record) throw new RuleStateError(404, 'action-run-unavailable')
      const active = running.get(runId)
      if (active?.sessionId === sessionId) { active.controller.abort(new Error('action-cancel-requested')); await state(sessionId, runId, { cancellationRequested: true }); return }
      if (record.status === 'queued') {
        const queue = pending.get(sessionId) ?? [], index = queue.findIndex(item => item.run.id === runId)
        if (index >= 0) queue.splice(index, 1)
        await state(sessionId, runId, { status: 'cancelled', reason: 'cancelled-before-start' })
      }
    },
    close() {
      if (closing) return closing
      closed = true
      for (const { controller } of running.values()) controller.abort(new Error('action-runs-closed'))
      closing = (async () => {
        await Promise.allSettled(enqueuing)
        const resources: (() => Promise<unknown>)[] = [...pending].flatMap(([sessionId, queue]) => queue.map(item => async () => {
          if (actionRunRecords(store.read(sessionId).runtime).find(run => run.id === item.run.id)?.status === 'queued') await state(sessionId, item.run.id, { status: 'skipped', reason: 'host-closed' })
        }))
        resources.push(...[...draining.values()].map(operation => () => operation))
        const errors: unknown[] = []
        try { for (const release of resources) { try { await release() } catch (error) { errors.push(error) } } } finally { pending.clear() }
        if (errors.length) throw new AggregateError(errors, 'context-care-resources-close-failed')
      })()
      return closing
    },
  }
}
