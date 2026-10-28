import { z } from 'zod'
import { parseDocument } from 'yaml'
import { StageAction } from './stage-schema.js'
import { Identifier, InputRecord, OwnedJson, parseInput } from './input-schema.js'

/** 原生适配器只提供文档文本和失效事实，不解释规则字段。 */
export interface RuleSourceDocument { id: string; rootId: string; title?: string; text: string }
export type RuleSourceChange = { key: string } & ({ kind: 'ready' } | { kind: 'offline'; message?: string } | { kind: 'change'; roots?: readonly string[]; marker?: boolean })
export interface RuleDocumentPorts {
  plugin: string
  refreshMs: number
  keys(): string[]
  sourceId(key: string): string
  read(key: string, roots: string[] | undefined, signal: AbortSignal): Promise<RuleSourceDocument[]>
  accepts(key: string, sessionId: string): boolean
  watch(receive: (event: RuleSourceChange) => void): () => Promise<void>
  report(message: string): void
}
interface SourceHandle { replace(input: unknown): void; dispose(): Promise<void> }
export interface DocumentSourceRegistry {
  registerSource(input: unknown, options: { acceptSession: (sessionId: string) => boolean; collectInvalid: true }): SourceHandle
}
const templateKinds = new Set(StageAction.options.filter(schema => 'template' in schema.shape && !schema.shape.template.isOptional()).map(schema => schema.shape.kind.value))

/** 围栏只解码共同声明，不识别或升级任何旧规则格式。语义校验仅在注册入口执行一次。 */
function declaration(document: RuleSourceDocument) {
  const fence = /^```dsh-rule\s*\r?\n([\s\S]*?)^```\s*$/gm
  const found = fence.exec(document.text)
  if (!found || fence.exec(document.text)) throw new Error('rule document requires exactly one dsh-rule code block')
  const yaml = parseDocument(found[1], { uniqueKeys: true })
  if (yaml.errors.length) throw new Error(yaml.errors.map(error => error.message).join('; '))
  const value = parseInput(InputRecord, parseInput(OwnedJson, yaml.toJS({ maxAliasCount: 100 }), 'rule document'), 'rule document')
  const id = parseInput(Identifier, value.id, 'rule document id')
  const body = document.text.replace(found[0], '').trim()
  const actions = parseInput(z.array(InputRecord), value.actions, 'rule document actions')
  return { ...value, id: `${document.id}:${id}`, title: document.title ?? value.title,
    actions: actions.map(action => typeof action.kind === 'string' && [...templateKinds].some(kind => kind === action.kind) && body ? { ...action, template: body } : action) }
}
interface CachedDocument { root: string; signature: string; rule?: unknown; diagnostic?: { id: string; message: string } }
interface SourceCache {
  ready: boolean; controller: AbortController; full: boolean; roots: Set<string>; retry: boolean; scanning: boolean
  documents: Map<string, CachedDocument>; pending?: { sourceId: string; plugin: string; revision: number; rules: unknown[]; diagnostics: { id: string; message: string }[] }; content?: string; handle?: SourceHandle
}

/** 文档目录、增量失效、容量重试和撤回全部由引擎拥有。 */
export function connectRuleDocuments(registry: DocumentSourceRegistry, ports: RuleDocumentPorts) {
  let closed = false, revision = 0
  let active: Promise<void> | undefined
  const caches = new Map<string, SourceCache>(), retiring = new Set<Promise<void>>()
  const cacheFor = (key: string) => {
    let cache = caches.get(key)
    if (!cache) { cache = { ready: false, controller: new AbortController(), full: false, roots: new Set(), retry: false, scanning: false, documents: new Map() }; caches.set(key, cache) }
    return cache
  }
  const remove = (cache: SourceCache) => {
    const handle = cache.handle; cache.handle = undefined; cache.content = undefined
    if (handle) { const task = handle.dispose().catch(error => ports.report(String(error))); retiring.add(task); void task.finally(() => retiring.delete(task)) }
  }
  const publish = (key: string, cache: SourceCache) => {
    const source = cache.pending
    if (!source || !cache.ready || closed) return
    const content = JSON.stringify([source.rules, source.diagnostics])
    if (cache.content === content) { cache.pending = undefined; return }
    try {
      if (cache.handle) cache.handle.replace(source)
      else cache.handle = registry.registerSource(source, { acceptSession: sessionId => ports.accepts(key, sessionId), collectInvalid: true })
      cache.content = content; cache.pending = undefined
      for (const diagnostic of source.diagnostics) ports.report(diagnostic.id + ': ' + diagnostic.message)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'reminder-capacity-exceeded')) { remove(cache); cache.pending = undefined }
      ports.report(source.sourceId + ': ' + String(error instanceof Error ? error.message : error))
    }
  }
  const scan = async (key: string, cache: SourceCache) => {
    const full = cache.full, roots = new Set(cache.roots), signal = cache.controller.signal
    cache.full = false; cache.roots.clear(); cache.retry = false; cache.scanning = true
    try {
      const documents = await ports.read(key, full ? undefined : [...roots], signal)
      signal.throwIfAborted()
      if (closed || !cache.ready || !ports.keys().includes(key)) return
      const next = full ? new Map<string, CachedDocument>() : new Map([...cache.documents].filter(([, document]) => !roots.has(document.root)))
      for (const document of documents) {
        const signature = JSON.stringify([document.title, document.text]), previous = cache.documents.get(document.id)
        let parsed: CachedDocument
        if (previous?.signature === signature) parsed = { ...previous, root: document.rootId }
        else {
          parsed = { root: document.rootId, signature }
          try { parsed.rule = declaration(document) }
          catch (error) { parsed.diagnostic = { id: document.id, message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) } }
        }
        next.set(document.id, parsed)
      }
      cache.documents = next
      const values = [...next].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
      cache.pending = { sourceId: ports.sourceId(key), plugin: ports.plugin, revision: ++revision, rules: values.flatMap(value => value.rule === undefined ? [] : [value.rule]), diagnostics: values.flatMap(value => value.diagnostic ? [value.diagnostic] : []) }
      publish(key, cache)
    } catch (error) {
      if (signal.aborted || closed) return
      remove(cache); cache.pending = undefined; cache.retry = true
      ports.report(ports.sourceId(key) + ': ' + String(error instanceof Error ? error.message : error))
    } finally { cache.scanning = false }
  }
  const kick = () => {
    if (closed) return Promise.resolve()
    active ??= Promise.resolve().then(async () => {
      for (;;) { const dirty = [...caches].filter(([, cache]) => cache.ready && (cache.full || cache.roots.size)); if (!dirty.length || closed) break; await Promise.all(dirty.map(([key, cache]) => scan(key, cache))) }
    }).finally(() => { active = undefined; if (!closed && [...caches.values()].some(cache => cache.ready && (cache.full || cache.roots.size))) void kick().catch(error => ports.report(String(error))) })
    return active
  }
  const receive = (event: RuleSourceChange) => {
    if (closed) return
    const cache = cacheFor(event.key)
    if (event.kind === 'offline') {
      cache.ready = false; cache.controller.abort(); cache.full = false; cache.roots.clear(); cache.pending = undefined; cache.retry = false; remove(cache)
      if (event.message) ports.report(event.key + ': ' + event.message)
      return
    }
    if (event.kind === 'ready') { cache.controller.abort(); cache.controller = new AbortController(); cache.ready = true; cache.full = true }
    else {
      if (!cache.ready) return
      if (!event.roots) cache.full = true
      else { const known = new Set([...cache.documents.values()].map(document => document.root)); for (const root of event.roots) if (cache.scanning || cache.full || cache.retry || event.marker || known.has(root)) cache.roots.add(root) }
    }
    void kick().catch(error => ports.report(String(error)))
  }
  const unwatch = ports.watch(receive)
  const timer = setInterval(() => { for (const [key, cache] of caches) { if (!cache.ready) continue; if (cache.retry) cache.full = true; else publish(key, cache) } void kick().catch(error => ports.report(String(error))) }, ports.refreshMs)
  timer.unref()
  return {
    refresh() { const current = new Set(ports.keys()); for (const [key, cache] of caches) { if (!current.has(key)) { receive({ key, kind: 'offline' }); caches.delete(key) } else if (cache.ready) cache.full = true } return kick() },
    async dispose() { closed = true; clearInterval(timer); for (const cache of caches.values()) { cache.controller.abort(); remove(cache) } await unwatch(); await active; await Promise.allSettled([...retiring]); caches.clear() },
  }
}
