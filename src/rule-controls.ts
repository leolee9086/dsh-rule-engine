import { z } from 'zod'
import { normalizeRule } from './rules.js'
import { hasStageRules } from './block-rules.js'
import type { NormalizedRule } from './types.js'
import { RuleStateError } from './declarations.js'
import { isRecord } from './guard.js'
import { Recipient } from './recipient-schema.js'
import { indexFirstControlIds, indexControlSources, createControlPreferenceIndex } from './control-decision-index.js'
import type { PlanningDecision } from './planning-types.js'

const Id = z.string().min(1).max(256)
const Action = z.object({ id: Id, title: z.string().optional(), defaultEnabled: z.boolean().default(true),
  available: z.boolean().default(true), reason: z.string().optional(), requires: z.array(Id).default([]) }).strict()
const Rule = z.object({ id: Id, title: z.string().optional(), description: z.string().optional(), actions: z.array(Action).min(1), definition: z.json().optional() }).strict()
export const ControlSource = z.object({ sourceId: Id, plugin: z.string().nullable(), registration: z.string(), executor: z.string(),
  sessionId: Id.optional(), scope: Recipient.optional(), readOnly: z.boolean().optional(), rules: z.array(Rule) }).strict()
const Preference = z.object({ sourceId: Id, ruleId: Id, paused: z.boolean().default(false), actions: z.record(z.string(), z.boolean()).default({}),
  sinceSeq: z.number().int().default(-1), epoch: z.number().int().nonnegative().default(0) }).strict()
export const StoredControls = z.object({ revision: z.number().int().nonnegative(), preferences: z.array(Preference) }).strict()
export const ControlPatch = z.object({ revision: z.number().int().nonnegative(), sourceId: Id, ruleId: Id,
  actionId: Id.optional(), enabled: z.boolean().optional(), paused: z.boolean().optional(), reset: z.literal(true).optional() }).strict()
  .refine(value => Number(value.reset === true) + Number(value.paused !== undefined) + Number(value.actionId !== undefined && value.enabled !== undefined) === 1,
    'choose pause, action toggle, or reset')
  .refine(value => (value.actionId === undefined) === (value.enabled === undefined), 'actionId and enabled belong together')
type Source = z.infer<typeof ControlSource>
type Stored = z.infer<typeof StoredControls>
type Pref = z.infer<typeof Preference>
type IndexedRule = { sourceId: string; id: string; actions: ReadonlyMap<string, Source['rules'][number]['actions'][number]> }
export interface ControlOptions {
  entries?: readonly (readonly [string, unknown])[]
  save(sessionId: string, record: Stored): Promise<unknown>
  boundary?(sessionId: string): number
  changed?(sessionId?: string): void
  compile?(input: unknown): NormalizedRule
}
export type ControlSelect = (sourceId: string, ruleId: string, actionId: string) => PlanningDecision
const identity = (sourceId: string, ruleId: string) => JSON.stringify([sourceId, ruleId])

/** 来源、偏好 CAS 和同步决策批次共用一个策略所有者。 */
export function createRuleControls({ entries = [], save, boundary = () => -1, changed = () => {}, compile = (input: unknown) => normalizeRule(input, 0) }: ControlOptions) {
  const records = new Map<string, Stored>(entries.map(([id, value]) => [id, StoredControls.parse(value)]))
  const sources = new Map<string, Source>(), providers = new Set<(sessionId: string) => readonly unknown[]>()
  const chains = new Map<string, Promise<unknown>>(), failures = new Map<string, unknown>(), samples = new Map<string, Record<string, unknown>>()
  let removed = 0, closed = false
  const stored = (sessionId: string): Stored => records.get(sessionId) ?? { revision: 0, preferences: [] }
  function validate(input: unknown): Source {
    const value = ControlSource.parse(input), ids = new Set<string>()
    for (const rule of value.rules) {
      if (ids.has(rule.id)) throw new Error(`context-care: duplicate rule ${rule.id}`)
      ids.add(rule.id)
      const actions = indexFirstControlIds(rule.actions)
      const definition = isRecord(rule.definition) ? rule.definition : undefined
      const action = definition && isRecord(definition.action) ? definition.action : undefined
      if (action?.by === 'context-care') compile({ ...definition, id: rule.id })
      if (definition?.schemaVersion === 2) {
        const normalized = compile(definition)
        if (!hasStageRules(normalized)) throw new Error('control-stage-fields-required')
        if (normalized.sourceId !== value.sourceId || normalized.id !== rule.id) throw new Error('context-care: v2 definition identity mismatch')
        if (normalized.actions.length !== rule.actions.length || normalized.actions.some(item => {
          const control = actions.get(item.id)
          return !control || control.defaultEnabled !== item.enabledDefault || JSON.stringify(control.requires) !== JSON.stringify(item.dependsOn)
        })) throw new Error('context-care: v2 action controls mismatch')
      }
      if (action?.by === 'context-care' && typeof action.kind === 'string' && !actions.has(action.kind)) throw new Error(`context-care: missing control action ${action.kind} in ${rule.id}`)
      if (actions.size !== rule.actions.length) throw new Error(`context-care: duplicate actions in ${rule.id}`)
      const visited = new Set<string>(), visiting = new Set<string>()
      const visit = (item: Source['rules'][number]['actions'][number]): void => {
        if (visiting.has(item.id)) throw new Error(`context-care: cyclic action dependency in ${rule.id}`)
        if (visited.has(item.id)) return
        visiting.add(item.id)
        for (const required of item.requires) {
          const parent = actions.get(required)
          if (!parent) throw new Error(`context-care: unknown action dependency ${required}`)
          visit(parent)
        }
        visiting.delete(item.id); visited.add(item.id)
      }
      for (const item of rule.actions) visit(item)
    }
    return value
  }
  function catalog(sessionId: string): Source[] {
    if (closed) return []
    const result = [...sources.values(), ...[...providers].flatMap(provider => provider(sessionId).map(validate))]
      .filter(source => source.sessionId === undefined || source.sessionId === sessionId)
    const ids = new Set<string>()
    for (const source of result) {
      if (ids.has(source.sourceId)) throw new Error(`context-care: conflicting source ${source.sourceId}`)
      ids.add(source.sourceId)
    }
    return result
  }
  let preferenceBatch: { sessionId: string; index: ReturnType<typeof createControlPreferenceIndex<Pref>> } | undefined
  function withPreferences<T>(sessionId: string, run: () => T): T {
    if (preferenceBatch?.sessionId === sessionId) return run()
    const previous = preferenceBatch, index = createControlPreferenceIndex(() => records.get(sessionId))
    preferenceBatch = { sessionId, index }
    try { return run() } finally { index.clear(); preferenceBatch = previous }
  }
  function preference(sessionId: string, sourceId: string, ruleId: string) {
    return preferenceBatch?.sessionId === sessionId ? preferenceBatch.index.get(sourceId, ruleId)
      : stored(sessionId).preferences.find(item => item.sourceId === sourceId && item.ruleId === ruleId)
  }
  function decisionFor(sessionId: string, rule: IndexedRule | undefined, actionId: string): PlanningDecision {
    if (!sessionId || closed || failures.has(sessionId)) return { enabled: false, reason: 'storage-unavailable' }
    const action = rule?.actions.get(actionId)
    if (!rule || !action) return { enabled: false, reason: 'source-unavailable' }
    const pref = preference(sessionId, rule.sourceId, rule.id)
    if (pref?.paused) return { enabled: false, reason: 'rule-paused' }
    if (!(pref?.actions[actionId] ?? action.defaultEnabled ?? true)) return { enabled: false, reason: 'action-disabled' }
    if (action.available === false) return { enabled: false, reason: action.reason ?? 'executor-unavailable' }
    for (const required of action.requires) if (!decisionFor(sessionId, rule, required).enabled) return { enabled: false, reason: 'dependency-disabled' }
    return { enabled: true, reason: 'enabled' }
  }
  function decision(sessionId: string, sourceId: string, ruleId: string, actionId: string) {
    const directory = indexControlSources(catalog(sessionId))
    try { return withPreferences(sessionId, () => decisionFor(sessionId, directory.get(sourceId, ruleId), actionId)) } finally { directory.clear() }
  }
  function withDecisions<T>(sessionId: string, run: (select: ControlSelect) => T): T {
    const bySource = indexControlSources(catalog(sessionId)), capturedRemoval = removed
    return withPreferences(sessionId, () => {
      let active = true
      try {
        const result = run((sourceId, ruleId, actionId) => {
          if (!active) throw new Error('control-decision-batch-closed')
          if (capturedRemoval !== removed) return decisionFor(sessionId, undefined, actionId)
          return decisionFor(sessionId, bySource.get(sourceId, ruleId), actionId)
        })
        if (isRecord(result) && typeof result.then === 'function') throw new Error('control-decision-batch-must-be-synchronous')
        return result
      } finally { active = false; bySource.clear() }
    })
  }
  function snapshot(sessionId: string) {
    return withPreferences(sessionId, () => {
      const record = stored(sessionId), current = catalog(sessionId), indexed = indexControlSources(current)
      try { return { sessionId, revision: record.revision, storageError: failures.has(sessionId) ? 'storage-unavailable' : undefined,
        sample: samples.get(sessionId), sources: current.map(source => ({ ...source, rules: source.rules.map(rule => {
          const pref = preference(sessionId, source.sourceId, rule.id)
          return { ...rule, definition: undefined, paused: pref?.paused ?? false, actions: rule.actions.map(action => ({ ...action,
            selected: pref?.actions[action.id] ?? action.defaultEnabled ?? true, ...decisionFor(sessionId, indexed.get(source.sourceId, rule.id), action.id) })) }
        }) })) } } finally { indexed.clear() }
    })
  }
  function patch(sessionId: string, input: unknown) {
    const change = ControlPatch.parse(input)
    const task = (chains.get(sessionId) ?? Promise.resolve()).catch((previousError: unknown) => { if (!(previousError instanceof RuleStateError)) throw previousError }).then(async () => {
      if (closed) throw new RuleStateError(503, 'controls-closed')
      const previous = stored(sessionId)
      if (change.revision !== previous.revision) throw new RuleStateError(409, 'revision-conflict')
      const rule = catalog(sessionId).find(source => source.sourceId === change.sourceId)?.rules.find(item => item.id === change.ruleId)
      if (!rule) throw new RuleStateError(404, 'rule-unavailable')
      if (change.actionId !== undefined && !rule.actions.some(action => action.id === change.actionId)) throw new RuleStateError(404, 'action-unavailable')
      const old = preference(sessionId, change.sourceId, change.ruleId)
      const pref: Pref = { sourceId: change.sourceId, ruleId: change.ruleId, paused: old?.paused ?? false, actions: { ...old?.actions }, sinceSeq: boundary(sessionId), epoch: previous.revision + 1 }
      if (change.reset) { pref.paused = false; pref.actions = {} }
      else if (change.paused !== undefined) pref.paused = change.paused
      else if (change.actionId !== undefined && change.enabled !== undefined) pref.actions[change.actionId] = change.enabled
      const next = { revision: previous.revision + 1, preferences: [...previous.preferences.filter(item => identity(item.sourceId, item.ruleId) !== identity(pref.sourceId, pref.ruleId)), pref] }
      try { await save(sessionId, structuredClone(next)) } catch (error) { failures.set(sessionId, error); changed(sessionId); throw new RuleStateError(503, 'storage-unavailable', error) }
      records.set(sessionId, next); failures.delete(sessionId); changed(sessionId)
      return snapshot(sessionId)
    })
    chains.set(sessionId, task)
    return task
  }
  return {
    register(input: unknown) {
      if (closed) throw new RuleStateError(503, 'controls-closed')
      const source = validate(input)
      if (sources.has(source.sourceId)) throw new Error(`context-care: duplicate source ${source.sourceId}`)
      sources.set(source.sourceId, source); changed(source.sessionId)
      return () => { if (sources.get(source.sourceId) === source) { sources.delete(source.sourceId); removed++; changed(source.sessionId) } }
    },
    registerProvider(provider: (sessionId: string) => readonly unknown[]) {
      if (closed) throw new RuleStateError(503, 'controls-closed')
      providers.add(provider); changed()
      return () => { providers.delete(provider); removed++; changed() }
    },
    catalog, decision, withDecisions, snapshot, patch,
    enabled: (sessionId: string, sourceId: string, ruleId: string, actionId: string) => decision(sessionId, sourceId, ruleId, actionId).enabled,
    sinceSeq: (sessionId: string, sourceId: string, ruleId: string) => preference(sessionId, sourceId, ruleId)?.sinceSeq ?? -1,
    epoch: (sessionId: string, sourceId: string, ruleId: string) => `${removed}:${preference(sessionId, sourceId, ruleId)?.epoch ?? 0}:${failures.has(sessionId)}`,
    revision: (sessionId: string) => stored(sessionId).revision,
    currentSample: (sessionId: string) => samples.get(sessionId),
    sample(sessionId: string, value: Record<string, unknown>) { if (!closed) { samples.set(sessionId, { ...value, at: Date.now() }); changed(sessionId) } },
    async close() {
      closed = true
      const settled = await Promise.allSettled(chains.values())
      sources.clear(); providers.clear(); samples.clear()
      const unexpected = settled.flatMap(result => result.status === 'rejected' && !(result.reason instanceof RuleStateError) ? [result.reason] : [])
      if (unexpected.length) throw new AggregateError(unexpected, 'context-care: controls shutdown failed')
    },
  }
}
export type RuleControls = ReturnType<typeof createRuleControls>
