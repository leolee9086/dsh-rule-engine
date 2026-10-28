import { validateDocument, validateDocumentSet, documentDefinitions, documentRule, documentSource, type RuleDocument } from './declarations.js'
import { assertFileRevision } from './document-revisions.js'
import { groupRulesBySource } from './request-rule-index.js'
import { isRecord } from './guard.js'
import type { NormalizedRuleV2, V2Action } from './block-rules.js'
import type { EngineRuntime } from './runtime-types.js'
import type { Availability } from './availability.js'

export interface DocumentContribution {
  plugin: string
  registrationId?: string
  sessionId?: string
  filePath?: string
  documents: RuleDocument[]
  admission: ReadonlyMap<string, number>
  ruleAdmissions?: ReadonlyMap<string, ReadonlyMap<string, number>>
}
export interface RuleFile { path: string; document: unknown; [key: string]: unknown }
export interface DocumentRegistryOptions {
  templates?: Parameters<typeof validateDocument>[1]
  compile?: Parameters<typeof validateDocument>[2]
  plugin?: string
  /** 只读取原生水位；来源作用域与修订身份由注册表计算。 */
  sessionBoundaries(): ReadonlyMap<string, number>
  documentSets(): ReadonlyMap<string, readonly RuleDocument[]>
  loadFiles?(): Promise<readonly RuleFile[]>
  changed?(id?: string): void
  report?(error: unknown): void
}
/** 文档来源、作用域重叠、文件原子刷新和历史准入在一个拥有者中维护。 */
export function createDocumentRegistry({ templates, compile, plugin = 'dsh-context-care', sessionBoundaries, documentSets, loadFiles, changed = () => {}, report = () => {} }: DocumentRegistryOptions) {
  const registrations = new Map<string, DocumentContribution>(), files = new Map<string, RuleFile & { document: RuleDocument }>()
  let generation = 0, closed = false, failure: Error | undefined, loading: Promise<void> | undefined
  const externalDocuments = (id: string) => [...registrations.values()].filter(source => !source.sessionId || source.sessionId === id).flatMap(source => source.documents)
  const contributor = (id: string, document: RuleDocument) => [...registrations.values()].find(source => (!source.sessionId || source.sessionId === id) && source.documents.includes(document))
  function assertOpen(): void { if (closed) throw new Error('workbench-closed') }
  return {
    token: () => generation,
    failure: () => failure,
    externalDocuments,
    contributor,
    documents(id: string, local: readonly RuleDocument[]) {
      const docs = [...local, ...externalDocuments(id)]; validateDocumentSet(docs, templates); return docs
    },
    admissions(id: string, rules: readonly NormalizedRuleV2[], documents: readonly RuleDocument[], runtime: EngineRuntime, sinceSeq: (sourceId: string, ruleId: string) => number) {
      const bySource = new Map(documents.map(document => [documentSource(document), document]))
      return new Map(rules.map(rule => {
        const document = bySource.get(rule.sourceId)
        if (!document) throw new Error('rule-document-unavailable')
        const owner = contributor(id, document), identity = JSON.stringify([rule.id, rule.revision])
        const stored = runtime.state[`$admission:${document.id}`], fact = isRecord(stored) ? stored[identity] : undefined
        const seq = owner ? (owner.ruleAdmissions?.get(identity) ?? owner.admission).get(id) ?? -1 : isRecord(fact) && typeof fact.seq === 'number' ? fact.seq : -1
        return [rule, Math.max(seq, sinceSeq(rule.sourceId, rule.id))]
      }))
    },
    catalog(id: string, docs: readonly RuleDocument[], availability: (action: V2Action, rule: NormalizedRuleV2) => Availability) {
      const bySource = groupRulesBySource(documentDefinitions(docs, compile))
      return docs.map(document => {
        const owner = contributor(id, document), sourceId = documentSource(document)
        return { readOnly: owner !== undefined, sourceId, sessionId: id, plugin: owner?.plugin ?? plugin,
          registration: owner?.filePath ?? owner?.registrationId ?? document.title, executor: plugin,
          rules: (bySource.get(sourceId) ?? []).map(rule => ({ id: rule.id, title: rule.title, description: rule.description, definition: rule,
            actions: rule.actions.map(action => ({ id: action.id, title: action.kind, defaultEnabled: action.enabledDefault, requires: action.dependsOn, ...availability(action, rule) })) })) }
      })
    },
    async reloadFiles(): Promise<void> {
      assertOpen()
      if (!loadFiles) return
      if (loading) return loading
      loading = (async () => {
        try {
          const loaded = await loadFiles(); assertOpen()
          const next = loaded.map(item => ({ ...item, document: validateDocument(item.document, templates, compile) }))
          for (const item of next) assertFileRevision(files.get(item.path)?.document, item.document)
          const foreign = [...registrations.values()].filter(owner => !owner.filePath), docs = next.map(item => item.document)
          validateDocumentSet([...foreign.filter(owner => !owner.sessionId).flatMap(owner => owner.documents), ...docs], templates)
          const localSets = documentSets(), ids = new Set(localSets.keys())
          for (const owner of foreign) if (owner.sessionId) ids.add(owner.sessionId)
          for (const id of ids) validateDocumentSet([...(localSets.get(id) ?? []), ...foreign.filter(owner => !owner.sessionId || owner.sessionId === id).flatMap(owner => owner.documents), ...docs], templates)
          // 全部校验完成后同步发布；失败刷新保留旧定义但使自动执行可见地失效。
          for (const item of next) {
            const previous = files.get(item.path)
            if (previous && JSON.stringify(previous.document) === JSON.stringify(item.document)) { files.set(item.path, item); continue }
            const admission = sessionBoundaries(), oldOwner = registrations.get(`$file:${item.path}`)
            const rules = [...item.document.rules.map(documentRule), ...item.document.entries.map(entry => ({ ...entry, id: `entry:${entry.id}` }))]
            const ruleAdmissions = new Map(rules.map(rule => {
              const key = JSON.stringify([rule.id, rule.revision])
              return [key, previous?.document.id === item.document.id ? oldOwner?.ruleAdmissions?.get(key) ?? admission : admission]
            }))
            registrations.set(`$file:${item.path}`, { plugin, filePath: item.path, documents: [item.document], admission, ruleAdmissions })
            files.set(item.path, item); generation++; changed()
          }
          if (failure) { failure = undefined; generation++ }
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error), { cause: error }); generation++; report(error); throw error }
      })()
      try { await loading } finally { loading = undefined }
    },
    register({ plugin: contributorPlugin, registrationId, sessionId, documents: contributed }: { plugin: string; registrationId: string; sessionId?: string; documents: readonly unknown[] }) {
      assertOpen()
      if (registrationId?.startsWith('$file:')) throw new Error('workbench-registration-reserved')
      if (!contributorPlugin || !registrationId || registrations.has(registrationId)) throw new Error('workbench-registration-conflict')
      const docs = contributed.map(document => validateDocument(document, templates, compile))
      const overlapping = [...registrations.values()].filter(source => !sessionId || !source.sessionId || source.sessionId === sessionId).flatMap(source => source.documents)
      validateDocumentSet([...overlapping, ...docs], templates)
      for (const [id, local] of documentSets()) if (!sessionId || id === sessionId) validateDocumentSet([...local, ...externalDocuments(id), ...docs], templates)
      const admission = new Map([...sessionBoundaries()].filter(([id]) => !sessionId || id === sessionId))
      const value = { plugin: contributorPlugin, registrationId, sessionId, documents: docs, admission }
      registrations.set(registrationId, value); generation++; changed(sessionId)
      return () => { if (registrations.get(registrationId) === value) { registrations.delete(registrationId); generation++; changed(sessionId) } }
    },
    assertPartialName(name: string) {
      const docs = [...documentSets().values()].flat().concat([...registrations.values()].flatMap(source => source.documents))
      if (docs.some(document => document.partials.some(partial => partial.name === name))) throw new Error('template-partial-conflict')
    },
    close(): Promise<void> | undefined { closed = true; return loading },
  }
}
