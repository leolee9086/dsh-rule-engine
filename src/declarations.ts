import { z } from 'zod'
import { hasStageRules } from './block-rules.js'
import { normalizeRule } from './rules.js'
import { isRecord } from './guard.js'
import type { createTemplates } from './templates.js'

const Id = z.string().min(1).max(256), Revision = z.number().int().positive()
export const Variable = z.object({ name: Id, scope: z.enum(['global', 'preset', 'session', 'turn']), type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  default: z.json(), description: z.string().max(4096).default('') }).strict().refine(value => value.type === 'array' ? Array.isArray(value.default)
    : value.type === 'object' ? value.default !== null && typeof value.default === 'object' && !Array.isArray(value.default) : typeof value.default === value.type, 'variable default type mismatch')
export const Entry = z.object({ id: Id, revision: Revision, title: z.string().max(4096), enabledDefault: z.boolean(), template: z.string().max(16384),
  activation: z.object({ kind: z.enum(['constant', 'keywords', 'condition']), keywords: z.array(z.string().min(1).max(4096)).max(256).optional(),
    mode: z.enum(['ANY', 'ALL']).optional(), caseSensitive: z.boolean().default(false), wordBoundary: z.boolean().default(false),
    secondary: z.object({ values: z.array(z.string().min(1)).min(1).max(256), mode: z.enum(['ANY', 'ALL', 'NOT-ANY', 'NOT-ALL']) }).strict().optional(),
    condition: z.json().optional() }).strict(),
  select: z.json(), target: z.object({ view: z.enum(['model', 'display']), role: z.enum(['system', 'developer', 'user', 'assistant']).default('user'),
    anchor: z.string().default('end'), position: z.enum(['before', 'after']).default('after'), depth: z.number().int().nonnegative().optional() }).strict(),
  priority: z.number().int().min(-100000).max(100000).default(0), exclusiveGroup: Id.optional(),
  cooldownMs: z.number().int().nonnegative().max(86400000).default(0), stickyTurns: z.number().int().nonnegative().max(10000).default(0),
  lifetime: z.enum(['request', 'turn', 'turns', 'until-inactive', 'session']).default('request'),
  lifetimeTurns: z.number().int().min(1).max(10000).optional(), activationCooldownMs: z.number().int().nonnegative().max(86400000).default(0),
  cascade: z.boolean().default(false), maxChars: z.number().int().positive().max(65536).default(16384),
}).strict().refine(entry => (entry.lifetime === 'turns') === (entry.lifetimeTurns !== undefined), 'lifetimeTurns is required only for turns lifetime')
  .refine(entry => entry.target.view === 'model' || entry.lifetime === 'request' && entry.stickyTurns === 0 && entry.activationCooldownMs === 0,
    'display entries require request lifetime without persistent activation')
export const Document = z.object({ schemaVersion: z.literal(2), id: Id, revision: Revision, title: z.string().max(4096),
  rules: z.array(z.json()).max(256).default([]), entries: z.array(Entry).max(256).default([]), variables: z.array(Variable).max(256).default([]),
  partials: z.array(z.object({ name: Id, revision: Revision, template: z.string().max(16384) }).strict()).max(64).default([]),
}).strict()
export type RuleDocument = z.infer<typeof Document>
export type RuleEntry = z.infer<typeof Entry>
export type RuleVariable = z.infer<typeof Variable>
type Templates = Pick<ReturnType<typeof createTemplates>, 'validate' | 'versions'>

/** code 与 status 由接入层用于现有 HTTP 展示，领域判断统一由引擎生成。 */
export class RuleStateError extends Error {
  constructor(readonly status: number, readonly code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
  }
}
export const documentSource = (document: { id: string }) => `context-care:document:${document.id}`

/** 条目作为统一条件和注入动作执行，生命周期独立记录在运行状态中。 */
const compileRule = (input: unknown) => normalizeRule(input, 0)
function entryDeclaration(document: Pick<RuleDocument, 'id'>, entry: RuleEntry, { sticky = false } = {}) {
  let match: unknown = entry.activation.kind === 'constant' || sticky ? { kind: 'always' }
    : entry.activation.kind === 'condition' ? entry.activation.condition
      : { kind: 'keywords', values: entry.activation.keywords, mode: entry.activation.mode ?? 'ANY', caseSensitive: entry.activation.caseSensitive, wordBoundary: entry.activation.wordBoundary }
  if (entry.activation.secondary && !sticky) match = { kind: 'all', conditions: [match, { kind: 'keywords', ...entry.activation.secondary,
    caseSensitive: entry.activation.caseSensitive, wordBoundary: entry.activation.wordBoundary }] }
  return { schemaVersion: 2, sourceId: documentSource(document), id: `entry:${entry.id}`, revision: entry.revision, title: entry.title,
    on: [entry.target.view === 'display' ? 'display.render' : 'request.assemble'], select: entry.select, match, priority: entry.priority,
    ...(entry.exclusiveGroup ? { exclusiveGroup: entry.exclusiveGroup } : {}),
    actions: [{ id: 'inject', kind: 'inject', enabledDefault: entry.enabledDefault, stage: entry.target.view === 'display' ? 'display.render' : 'request.assemble',
      template: entry.template, target: entry.target, cooldownMs: entry.cooldownMs, maxChars: entry.maxChars, dedupe: { mode: 'none' } }] }
}
export function entryRule(document: Pick<RuleDocument, 'id'>, entry: RuleEntry, { sticky = false, compile = compileRule } = {}) {
  const rule = compile(entryDeclaration(document, entry, { sticky }))
  if (!hasStageRules(rule)) throw new Error('entry-stage-fields-required')
  return rule
}
/** 每个文档切面持有独立的 partial 目录，保持全局 helper 与计量配置。 */
export function documentTemplates(templates: ReturnType<typeof createTemplates>, documents: readonly RuleDocument[]) {
  const renderer = templates.fork()
  for (const partial of documents.flatMap(document => document.partials)) renderer.registerPartial(partial)
  return renderer
}
/** 文档来源交给 Engine 注册表的声明；普通规则在共享入口中只规范化一次。 */
export function documentDeclarations(documents: readonly RuleDocument[]) {
  return documents.flatMap(document => [...document.rules.map(rule => ({ ...documentRule(rule), sourceId: documentSource(document) })),
    ...document.entries.map(entry => entryDeclaration(document, entry))])
}
export function documentDefinitions(documents: readonly RuleDocument[], compile = compileRule) {
  return documentDeclarations(documents).map(compile).filter(hasStageRules)
}
export function documentRule(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('document-rule-must-be-object')
  return value
}
export function validateDocument(input: unknown, templates?: Templates, compile = compileRule): RuleDocument {
  const document = Document.parse(input), ids = new Set<string>(), variables = new Set<string>(), partials = new Set<string>()
  for (const rule of document.rules) {
    const normalized = compile({ ...documentRule(rule), sourceId: documentSource(document) })
    if (ids.has(normalized.id)) throw new Error('document-duplicate-rule')
    ids.add(normalized.id)
    for (const action of normalized.actions ?? []) if (action.template !== undefined) templates?.validate(action.template)
  }
  for (const entry of document.entries) {
    if (ids.has(`entry:${entry.id}`)) throw new Error('document-duplicate-entry')
    ids.add(`entry:${entry.id}`); entryRule(document, entry, { compile }); templates?.validate(entry.template)
  }
  for (const variable of document.variables) {
    if (variables.has(variable.name) || ['__proto__', 'prototype', 'constructor'].includes(variable.name)) throw new Error('document-duplicate-or-unsafe-variable')
    variables.add(variable.name)
  }
  for (const partial of document.partials) {
    if (partials.has(partial.name)) throw new Error('document-duplicate-partial')
    partials.add(partial.name); templates?.validate(partial.template)
  }
  return document
}
export function validateDocumentSet(documents: readonly RuleDocument[], templates?: Templates): void {
  const ids = new Set<string>(), variables = new Set<string>(), partials = new Set(templates?.versions().partials.map(partial => partial.name) ?? [])
  for (const document of documents) {
    if (ids.has(document.id)) throw new RuleStateError(409, 'workbench-document-source-conflict')
    ids.add(document.id)
    for (const [field, names] of [['variables', variables], ['partials', partials]] satisfies readonly ['variables' | 'partials', Set<string>][]) {
      for (const item of document[field]) {
        if (names.has(item.name)) throw new RuleStateError(409, `cross-document-${field}-conflict`)
        names.add(item.name)
      }
    }
  }
}
export function variableKey(declaration: RuleVariable, turnId?: string) { return `${declaration.scope}:${declaration.scope === 'turn' ? `${turnId}:` : ''}${declaration.name}` }
export function validateVariableValue(declaration: RuleVariable, value: unknown): void {
  const correct = declaration.type === 'array' ? Array.isArray(value) : declaration.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === declaration.type
  if (!correct || (typeof value === 'number' && !Number.isFinite(value))) throw new RuleStateError(400, 'variable-type-mismatch')
}
export function variableSnapshot(record: { documents: readonly RuleDocument[]; variables: Record<string, unknown>; scopes?: Record<string, Record<string, unknown>> }, turnId: string,
  scopes: Record<string, Record<string, unknown>> = {}) {
  const result: Record<string, unknown> = {}
  for (const declaration of record.documents.flatMap(document => document.variables)) {
    if (Object.hasOwn(result, declaration.name)) throw new Error('variable-name-conflict')
    const value = record.variables[variableKey(declaration, turnId)] ?? record.scopes?.[declaration.scope]?.[declaration.name] ?? scopes[declaration.scope]?.[declaration.name] ?? declaration.default
    validateVariableValue(declaration, value); result[declaration.name] = structuredClone(value)
  }
  return result
}
