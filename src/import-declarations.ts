import { z } from 'zod'
import { validateDocument, type RuleDocument, type RuleEntry } from './declarations.js'
import { isRecord } from './guard.js'
import { createTemplates } from './templates.js'

type Templates = Parameters<typeof validateDocument>[1]
interface ImportNote { path: string; status: string; message: string }
export interface DeclarationImport { document: RuleDocument; report: ImportNote[]; importer?: { format: string; version: number } }
const WorldEntry = z.object({ uid: z.union([z.string().min(1).max(256), z.number().int().nonnegative()]).optional(), comment: z.string().max(4096).optional(),
  content: z.string().max(16384).optional(), constant: z.boolean().optional(), disable: z.boolean().optional(), selective: z.boolean().optional(),
  key: z.array(z.string().min(1).max(4096)).max(256).optional(), keysecondary: z.array(z.string().min(1).max(4096)).max(256).optional(),
  selectiveLogic: z.number().int().min(0).max(3).optional(), order: z.number().int().min(-100000).max(100000).optional(),
  position: z.number().int().optional(), depth: z.number().int().nonnegative().optional(), caseSensitive: z.boolean().optional(), matchWholeWords: z.boolean().optional(),
  scanDepth: z.number().int().min(1).max(10000).optional(), sticky: z.number().int().nonnegative().max(10000).optional(), cooldown: z.number().int().nonnegative().optional(), excludeRecursion: z.boolean().optional(),
}).passthrough()
const mapped = new Set(Object.keys(WorldEntry.shape))
const Script = z.object({ id: z.string().min(1).max(256).optional(), scriptName: z.string().max(4096).optional(), findRegex: z.string().min(1).max(4096),
  replaceString: z.string().max(16384), trimStrings: z.array(z.string()).default([]), placement: z.array(z.number().int()).min(1),
  disabled: z.boolean().default(false), markdownOnly: z.boolean().default(false), promptOnly: z.boolean().default(false), runOnEdit: z.boolean().default(false),
  substituteRegex: z.number().int().default(0), minDepth: z.number().int().nullable().optional(), maxDepth: z.number().int().nullable().optional(),
}).passthrough()
const fields = new Set(Object.keys(Script.shape))
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 外部格式只转换为统一声明；每个字段的未支持项与语义差异均保留报告。 */
export function importWorkbench(input: unknown, templates?: Templates): DeclarationImport {
  if (isRecord(input) && input.schemaVersion === 2) return { document: validateDocument(input, templates), report: [] }
  if (Array.isArray(input) || isRecord(input) && (input.regexScripts || input.findRegex !== undefined)) return importTavernRegex(input, templates)
  if (!isRecord(input) || !input.entries || typeof input.entries !== 'object') throw new Error('unsupported-import-format')
  const report: ImportNote[] = [], entries: RuleEntry[] = [], ids = new Set<string>()
  const base = { schemaVersion: 2, id: input.id ?? 'imported-world-info', revision: 1, title: input.name ?? 'Imported world info' }
  validateDocument({ ...base, entries: [] }, templates)
  for (const field of Object.keys(input)) if (!['id', 'name', 'entries'].includes(field)) report.push({ path: field, status: 'unsupported', message: 'Top-level field was not imported.' })
  for (const [key, raw] of Object.entries(input.entries)) {
    const path = `entries.${key}`
    const rejected = (field: string, text: string) => report.push({ path: field ? `${path}.${field}` : path, status: 'rejected', message: text })
    if (isRecord(raw)) for (const field of Object.keys(raw)) if (!mapped.has(field)) report.push({ path: `${path}.${field}`, status: 'unsupported', message: 'Field was not imported.' })
    const parsed = WorldEntry.safeParse(raw)
    if (!parsed.success) { for (const issue of parsed.error.issues) rejected(issue.path.join('.'), issue.message); rejected('', 'Invalid entry omitted; other entries are retained.'); continue }
    const row = parsed.data
    const target = row.position === 0 ? { role: 'system', anchor: 'start' } : (row.position ?? 1) === 1 ? { role: 'system', anchor: 'end' } : undefined
    if (!target) { rejected('position', 'Position has no equivalent supported request anchor; entry omitted.'); continue }
    if (row.content?.includes('{{')) { rejected('content', 'Source macros are not executed. Convert this content to a native template before importing; entry omitted.'); continue }
    const modes: readonly string[] = ['ANY', 'NOT-ALL', 'NOT-ANY', 'ALL']
    const secondary = !row.constant && row.selective && row.keysecondary?.length ? { values: row.keysecondary, mode: modes[row.selectiveLogic ?? 0] } : undefined
    const candidate = { id: String(row.uid ?? key), revision: 1, title: row.comment ?? String(row.uid ?? key), enabledDefault: row.disable !== true, template: row.content ?? '',
      activation: row.constant ? { kind: 'constant' } : { kind: 'keywords', keywords: row.key ?? [], caseSensitive: row.caseSensitive ?? false, wordBoundary: row.matchWholeWords ?? false, ...(secondary ? { secondary } : {}) },
      select: { view: 'model', roles: ['user', 'assistant', 'tool'], blockTypes: ['text'], depth: { unit: 'message', limit: row.scanDepth ?? 100 } },
      target: { view: 'model', position: 'after', ...target }, priority: row.order ?? 0, stickyTurns: row.sticky ?? 0, cooldownMs: 0, cascade: row.excludeRecursion === false }
    try {
      if (ids.has(candidate.id)) throw new Error('Duplicate entry ID; first accepted entry is retained.')
      if (entries.length >= 256) throw new Error('Entry limit exceeded (256).')
      const entry = validateDocument({ ...base, entries: [candidate] }, templates).entries[0]
      entries.push(entry); ids.add(entry.id)
    } catch (error) { rejected('', `${message(error)}; entry omitted.`); continue }
    for (const field of Object.keys(row).filter(field => mapped.has(field))) {
      let status = 'converted', text = 'Mapped to the native entry.'
      if (field === 'cooldown' && row.cooldown !== 0) { status = 'unsupported'; text = 'Source cooldown counts turns; no millisecond cooldown was applied.' }
      else if (field === 'depth') { status = 'unsupported'; text = 'Depth is unused at the selected system start/end anchor.' }
      else if (field === 'scanDepth') { status = 'difference'; text = 'Native depth counts messages, including tool results; source scan window semantics may differ.' }
      else if (field === 'sticky') { status = 'difference'; text = 'Mapped to native sticky turns; review against the source turn boundaries.' }
      else if (field === 'excludeRecursion') { status = 'difference'; text = 'Mapped to bounded native entry cascade, with visited identities preventing cycles.' }
      else if (row.constant && ['key', 'keysecondary', 'selective', 'selectiveLogic', 'caseSensitive', 'matchWholeWords'].includes(field)
        || ['keysecondary', 'selectiveLogic'].includes(field) && !secondary) { status = 'difference'; text = 'Inactive keyword field was not applied to activation.' }
      report.push({ path: `${path}.${field}`, status, message: text })
    }
    report.push({ path, status: 'converted', message: 'Imported entry with the field differences listed above.' })
  }
  return { document: validateDocument({ ...base, entries }, templates), report, importer: { format: 'tavern-world-info', version: 1 } }
}

/** 酒馆输入只负责声明适配；顺序、宏和切面条件进入共同程序。 */
export function importTavernRegex(input: unknown, templates?: Templates): DeclarationImport {
  const source = isRecord(input) ? input : {}, single = source.findRegex !== undefined
  const rawScripts = Array.isArray(input) ? input : single ? [input] : source.regexScripts
  if (!Array.isArray(rawScripts) || rawScripts.length > 256) throw new Error('invalid-tavern-regex-list')
  const base = { schemaVersion: 2, id: source.id ?? 'imported-tavern-regex', revision: 1, title: source.name ?? 'Imported Tavern regex' }
  validateDocument({ ...base, rules: [] }, templates)
  const report: ImportNote[] = [], rules: Record<string, unknown>[] = [], ids = new Set<string>()
  if (!Array.isArray(input) && !single) for (const key of Object.keys(source)) if (!['id', 'name', 'regexScripts'].includes(key)) report.push({ path: key, status: 'unsupported', message: 'Top-level field was not imported.' })
  rawScripts.forEach((raw: unknown, index: number) => {
    const path = `regexScripts.${index}`
    const note = (field: string, status: string, text: string) => report.push({ path: field ? `${path}.${field}` : path, status, message: text })
    const reject = (field: string, text: string) => { note(field, 'rejected', text); note('', 'rejected', 'Script omitted; other scripts are retained.') }
    if (raw && typeof raw === 'object') for (const field of Object.keys(raw)) if (!fields.has(field)) note(field, 'unsupported', 'Field was not imported.')
    const parsed = Script.safeParse(raw)
    if (!parsed.success) { for (const issue of parsed.error.issues) note(issue.path.join('.'), 'rejected', issue.message); reject('', 'Invalid script.'); return }
    const row = parsed.data
    if (![0, 1, 2].includes(row.substituteRegex)) { reject('substituteRegex', 'Pattern macro mode must be 0, 1 or 2.'); return }
    if (row.placement.some(value => ![1, 2, 6].includes(value))) { reject('placement', 'Placement has no equivalent input, output or reasoning surface.'); return }
    const id = row.id ?? `regex-${index}`
    if (ids.has(id)) { reject('id', 'Duplicate script ID.'); return }
    const placement = [...(row.placement.includes(1) ? ['user'] : []), ...(row.placement.includes(2) ? ['assistant'] : []), ...(row.placement.includes(6) ? ['reasoning'] : [])]
    const transform = { findRegex: row.findRegex, replaceString: row.replaceString, substituteRegex: row.substituteRegex, trimStrings: row.trimStrings }
    const stages = [...(row.markdownOnly ? ['display.render'] : []), ...(row.promptOnly ? ['request.assemble'] : [])]
    const selectors = [...(row.placement.includes(1) ? [{ roles: ['user'], blockTypes: ['text'] }] : []), ...(row.placement.includes(2) ? [{ roles: ['assistant'], blockTypes: ['text'] }] : []), ...(row.placement.includes(6) ? [{ roles: ['assistant'], blockTypes: ['reasoning'] }] : [])]
    const condition = { kind: 'surface', placement, markdownOnly: row.markdownOnly, promptOnly: row.promptOnly, runOnEdit: row.runOnEdit,
      minDepth: row.minDepth ?? null, maxDepth: row.maxDepth ?? null }
    const candidates: Record<string, unknown>[] = stages.flatMap(stage => selectors.map((select, part) => ({ schemaVersion: 2, id: `${id}:${stage}:${part}`, revision: 1,
      title: row.scriptName ?? id, priority: rawScripts.length - index, on: [stage], select: { ...select, view: stage === 'display.render' ? 'display' : 'model' },
      match: { kind: 'always' }, actions: [{ id: 'transform', kind: 'transform', stage, enabledDefault: !row.disabled, transform, condition }] })))
    // 源文本规则保留其显式输入面：由 run 同步交付，宿主决定如何保存源历史。
    if (!stages.length) candidates.push({ id, order: index, enabled: !row.disabled, placement, when: transform,
      markdownOnly: false, promptOnly: false, runOnEdit: row.runOnEdit, depth: { min: row.minDepth ?? null, max: row.maxDepth ?? null },
      action: { kind: 'transform' }, budget: { maxCacheLoss: 1 } })
    try { validateDocument({ ...base, rules: candidates }, templates) } catch (error) { reject('', message(error)); return }
    ids.add(id); rules.push(...candidates)
    for (const field of Object.keys(isRecord(raw) ? raw : {}).filter(field => fields.has(field))) note(field, 'converted', 'Mapped to the common sequential text program.')
    note('', 'converted', stages.length ? 'Imported as ordered text transformations on the selected request/display surface.' : 'Imported as a synchronous source text declaration.')
  })
  return { document: validateDocument({ ...base, rules }, templates), report, importer: { format: 'tavern-regex', version: 1 } }
}

/** 公开数据转换为每次调用创建独立模板目录。 */
export function importDeclarations(input: unknown): DeclarationImport { return importWorkbench(input, createTemplates()) }
