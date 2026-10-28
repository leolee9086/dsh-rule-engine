import { z } from 'zod'
import { Document, validateDocument, validateDocumentSet, variableKey, validateVariableValue, documentRule,
  RuleStateError, type RuleDocument, type RuleVariable } from './declarations.js'
import type { createTemplates } from './templates.js'
import type { EngineRuntime, ActionRunRecord, ActionState } from './runtime-types.js'
import { isRecord } from './guard.js'
import { actionRunRecords, isActionRunRecord } from './run-records.js'

export const StoredRules = z.object({ revision: z.number().int().nonnegative(), runtimeRevision: z.number().int().nonnegative(), documents: z.array(Document),
  variables: z.record(z.string(), z.json()), runtime: z.object({ runs: z.array(z.json()), state: z.record(z.string(), z.json()) }).strict() }).strict()
export interface RuleStoreRecord { revision: number; runtimeRevision: number; documents: RuleDocument[]; variables: Record<string, unknown>; runtime: EngineRuntime }
const empty = (): RuleStoreRecord => ({ revision: 0, runtimeRevision: 0, documents: [], variables: {}, runtime: { runs: [], state: {} } })
export interface RuleStoreOptions {
  entries?: readonly (readonly [string, unknown])[]
  save(id: string, value: RuleStoreRecord): Promise<unknown>
  templates?: Pick<ReturnType<typeof createTemplates>, 'validate' | 'versions'>
  compile?: Parameters<typeof validateDocument>[2]
  maxDocuments?: number
  maxRuns?: number
  report?(error: unknown): void
  externalDocuments?(id: string): readonly RuleDocument[]
  admissionSeq?(id: string): number
  changed?(id: string): void
}
export interface RuleStoreEdit {
  revision: number
  operation: string
  document?: unknown
  documentId?: string
  variable?: string
  value?: unknown
  turnId?: string
  presetId?: string
  scopeRevision?: number
}
const combinedRules = (document: RuleDocument): Record<string, unknown>[] => [
  ...document.rules.map(documentRule), ...document.entries.map(entry => ({ ...entry, id: `entry:${entry.id}` })),
]
function fieldNames(document: RuleDocument, field: 'variables' | 'partials'): string[] { return document[field].map(item => item.name) }

/** 每个 key 串行提交，存储 ACK 后发布新事实；领域状态与具体存储驱动通过 save 端口连接。 */
export function createRuleStore({ entries = [], save, templates, compile, maxDocuments = 64, maxRuns = 1000, report = () => {}, externalDocuments = () => [],
  admissionSeq = () => -1, changed = () => {} }: RuleStoreOptions) {
  const prospective = new Map<string, RuleDocument[]>()
  const records = new Map<string, RuleStoreRecord>(entries.map(([id, value]) => [id, StoredRules.parse(value)]))
  const chains = new Map<string, Promise<unknown>>(), failures = new Map<string, unknown>()
  let closed = false, closing = false, tokenRevision = 0
  for (const record of records.values()) for (const document of record.documents) validateDocument(document, templates, compile)
  const current = (id: string) => records.get(id) ?? empty()
  function mutate(id: string, change: (next: RuleStoreRecord) => unknown): Promise<unknown> {
    if (closed || closing) return Promise.reject(new RuleStateError(503, 'workbench-closed'))
    const task = (chains.get(id) ?? Promise.resolve()).catch((previous: unknown) => { report(previous) }).then(async () => {
      if (closed) throw new RuleStateError(503, 'workbench-closed')
      const next = structuredClone(current(id)), result = change(next)
      StoredRules.parse(next)
      validateDocumentSet([...next.documents, ...externalDocuments(id)], templates)
      prospective.set(id, next.documents)
      try {
        await save(id, structuredClone(next))
        records.set(id, next); failures.delete(id); tokenRevision++; changed(id)
      } catch (error) { failures.set(id, error); tokenRevision++; report(error); changed(id); throw new RuleStateError(503, 'workbench-storage-unavailable', error) }
      finally { prospective.delete(id) }
      return result ?? structuredClone(next)
    })
    chains.set(id, task)
    return task
  }
  function read(id: string, { presetId }: { presetId?: string } = {}) {
    const globalId = '$scope:global', presetScopeId = presetId === undefined ? undefined : `$scope:preset:${presetId}`
    const scopeValues = (scopeId: string) => Object.fromEntries(Object.entries(current(scopeId).variables).map(([key, value]) => [key.slice(key.indexOf(':') + 1), structuredClone(value)]))
    return { sessionId: id, ...structuredClone(current(id)), scopes: { global: scopeValues(globalId), preset: presetScopeId ? scopeValues(presetScopeId) : {} },
      scopeRevisions: { global: current(globalId).revision, preset: presetScopeId ? current(presetScopeId).revision : null },
      storageError: [id, globalId, presetScopeId].some(scopeId => scopeId !== undefined && failures.has(scopeId)) ? 'workbench-storage-unavailable' : undefined }
  }
  return {
    documentSets() {
      const sets = new Map([...records].filter(([id]) => !id.startsWith('$scope:')).map(([id, record]) => [id, structuredClone(prospective.get(id) ?? record.documents)]))
      for (const [id, documents] of prospective) if (!records.has(id)) sets.set(id, structuredClone(documents))
      return sets
    },
    read,
    tokenRevision: () => tokenRevision,
    token: (id: string, presetId?: string, variables = current(id).variables) => JSON.stringify([id, current(id).revision, variables, current('$scope:global').revision,
      presetId === undefined ? null : current(`$scope:preset:${presetId}`).revision, [...failures.keys()], closing, closed]),
    available: (id: string) => !closed && !closing && !failures.has(id) && ![...failures.keys()].some(key => key.startsWith('$scope:')),
    sessions: () => [...records.keys()].filter(id => !id.startsWith('$scope:')),
    async edit(id: string, { revision, operation, document, documentId, variable, value, turnId, presetId, scopeRevision }: RuleStoreEdit) {
      const declaration = current(id).documents.flatMap(item => item.variables).find(item => item.name === variable)
      if (operation === 'set-variable' && declaration && ['global', 'preset'].includes(declaration.scope)) {
        if (declaration.scope === 'preset' && !presetId) throw new RuleStateError(400, 'preset-id-required')
        const scopeId = declaration.scope === 'global' ? '$scope:global' : `$scope:preset:${presetId}`
        await mutate(scopeId, next => {
          if (current(id).revision !== revision || next.revision !== scopeRevision) throw new RuleStateError(409, 'workbench-revision-conflict')
          validateVariableValue(declaration, value)
          next.variables[variableKey(declaration)] = structuredClone(value); next.revision++
        })
        return read(id, { presetId })
      }
      await mutate(id, next => {
        if (next.revision !== revision) throw new RuleStateError(409, 'workbench-revision-conflict')
        const givenId = isRecord(document) ? document.id : documentId
        if (['put-document', 'delete-document'].includes(operation) && externalDocuments(id).some(item => item.id === givenId)) throw new RuleStateError(403, 'external-document-read-only')
        if (operation === 'put-document') {
          const parsed = validateDocument(document, templates, compile), previous = next.documents.find(item => item.id === parsed.id)
          if (parsed.revision !== (previous?.revision ?? 0) + 1) throw new RuleStateError(409, 'document-revision-conflict')
          const existing = new Map((previous ? combinedRules(previous) : []).map(rule => [rule.id, rule]))
          for (const rule of combinedRules(parsed)) {
            const old = existing.get(rule.id)
            if (old && typeof rule.revision === 'number' && typeof old.revision === 'number' && rule.revision < old.revision) throw new RuleStateError(409, 'rule-revision-regressed')
            if (old && JSON.stringify(rule) !== JSON.stringify(old) && rule.revision === old.revision) throw new RuleStateError(409, 'changed-rule-needs-revision')
          }
          next.documents = [...next.documents.filter(item => item.id !== parsed.id), parsed]
          const seq = admissionSeq(id)
          if (!Number.isSafeInteger(seq) || seq < -1) throw new RuleStateError(503, 'workbench-admission-seq-unavailable')
          const admissionKey = `$admission:${parsed.id}`, previousAdmission = next.runtime.state[admissionKey] ?? {}
          next.runtime.state[admissionKey] = Object.fromEntries(combinedRules(parsed).map(rule => {
            const key = JSON.stringify([rule.id, rule.revision]); return [key, (isRecord(previousAdmission) ? previousAdmission[key] : undefined) ?? { seq }]
          }))
          for (const field of ['variables', 'partials'] satisfies readonly ('variables' | 'partials')[]) {
            const names = next.documents.flatMap(item => fieldNames(item, field))
            if (new Set(names).size !== names.length) throw new RuleStateError(400, `cross-document-${field}-conflict`)
          }
          if (next.documents.length > maxDocuments) throw new RuleStateError(413, 'document-limit-exceeded')
        } else if (operation === 'delete-document') {
          if (!next.documents.some(item => item.id === documentId)) throw new RuleStateError(404, 'document-unavailable')
          next.documents = next.documents.filter(item => item.id !== documentId)
          delete next.runtime.state[`$admission:${documentId}`]
        } else if (operation === 'set-variable') {
          const variableDeclaration = next.documents.flatMap(item => item.variables).find(item => item.name === variable)
          if (!variableDeclaration) throw new RuleStateError(404, 'variable-unavailable')
          validateVariableValue(variableDeclaration, value)
          if (variableDeclaration.scope === 'turn' && !turnId) throw new RuleStateError(400, 'turn-id-required')
          next.variables[variableKey(variableDeclaration, turnId)] = structuredClone(value)
        } else throw new RuleStateError(400, 'unknown-workbench-operation')
        next.revision++
      })
      return read(id, { presetId })
    },
    runtime(id: string, update: (runtime: EngineRuntime) => unknown) {
      return mutate(id, next => {
        const result = update(next.runtime)
        if (isRecord(result) && result.then) throw new RuleStateError(400, 'runtime-update-must-be-synchronous')
        if (next.runtime.runs.length > maxRuns) {
          const removable = actionRunRecords(next.runtime).filter(run => ['succeeded', 'failed', 'skipped', 'cancelled'].includes(run.status))
          const remove = new Set(removable.slice(0, next.runtime.runs.length - maxRuns).map(run => run.id))
          next.runtime.runs = next.runtime.runs.filter(run => !isActionRunRecord(run) || !remove.has(run.id))
          if (next.runtime.runs.length > maxRuns) throw new RuleStateError(503, 'active-run-limit-exceeded')
        }
        next.runtimeRevision++
      })
    },
    async automaticVariable(id: string, declaration: RuleVariable, value: unknown, turnId?: string, assertCurrent = () => {}) {
      if (!['session', 'turn'].includes(declaration.scope)) throw new RuleStateError(403, 'automatic-variable-scope-denied')
      validateVariableValue(declaration, value)
      if (declaration.scope === 'turn' && !turnId) throw new RuleStateError(400, 'turn-id-required')
      return mutate(id, next => { assertCurrent(); next.variables[variableKey(declaration, turnId)] = structuredClone(value); next.runtimeRevision++ })
    },
    async close() {
      closing = true; tokenRevision++
      const settled = await Promise.allSettled(chains.values()); closed = true; tokenRevision++
      const errors = settled.flatMap(item => item.status === 'rejected' && !(item.reason instanceof RuleStateError) ? [item.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'workbench-close-failed')
    },
  }
}
export type RuleStore = ReturnType<typeof createRuleStore>
export type { ActionRunRecord, ActionState }
