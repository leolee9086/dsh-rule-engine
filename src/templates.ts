import Handlebars from 'handlebars'
import { bindInputs } from './block-rules.js'
import { sanitizeRegexMacro } from './regex.js'
import { isRecord } from './guard.js'

const unsafe = new Set(['__proto__', 'prototype', 'constructor'])
const allowed = new Set(['if', 'unless', 'each', 'with', 'eq', 'json', 'regexEscape'])
const disabledHelpers = new Set(['lookup', 'log', 'helperMissing', 'blockHelperMissing'])
type Json = null | string | boolean | number | readonly Json[] | { readonly [key: string]: Json }

/** 以数据属性构造只读快照，确保模板与扩展 helper 读取同一份稳定 JSON。 */
function frozenJson(value: unknown, depth = 0): Json {
  if (depth > 32) throw new Error('template-snapshot-too-deep')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object') throw new Error('template-snapshot-requires-json')
  const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('template-snapshot-requires-json')
  const fields = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string') throw new Error('template-snapshot-requires-json')
    if (unsafe.has(key)) throw new Error('template-dangerous-property')
    if (!Object.hasOwn(fields[key], 'value')) throw new Error('template-snapshot-accessor-denied')
  }
  if (array) {
    const out: Json[] = []
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(fields, index)) throw new Error('template-snapshot-requires-json')
      out.push(frozenJson(fields[String(index)].value, depth + 1))
    }
    if (Object.keys(fields).length !== value.length + 1) throw new Error('template-snapshot-requires-json')
    return Object.freeze(out)
  }
  const out: Record<string, Json> = {}
  for (const [key, field] of Object.entries(fields)) if (field.value !== undefined) out[key] = frozenJson(field.value, depth + 1)
  return Object.freeze(out)
}
export interface TemplateOptions { maxTemplateChars?: number; maxOutputChars?: number; maxIterations?: number; maxPartialDepth?: number }
export interface TemplatePartial { name: string; revision: number; template: string }
export interface TemplateHelper { name: string; revision: number; render: (...values: unknown[]) => unknown }
interface TemplateFrame { iterations: number; partialDepth: number }
interface RenderOptions {
  data?: Record<string, unknown>
  blockParams?: unknown[]
  allowProtoMethodsByDefault?: boolean
  allowProtoPropertiesByDefault?: boolean
}
type Renderer = (context: unknown, options?: RenderOptions) => string
interface EachOptions {
  data?: Record<string, unknown>
  inverse(context: unknown): string
  fn(context: unknown, options: RenderOptions): string
}
function isEachOptions(value: unknown): value is EachOptions {
  return isRecord(value) && typeof value.inverse === 'function' && typeof value.fn === 'function'
}

/** 所有消费者共用模板校验、helper 注册、partial 递归和输出预算。 */
export function createTemplates({ maxTemplateChars = 16384, maxOutputChars = 65536, maxIterations = 256, maxPartialDepth = 8 }: TemplateOptions = {}) {
  const env = Handlebars.create()
  const partials = new Map<string, TemplatePartial & { wrapped: Renderer }>(), helpers = new Map<string, Omit<TemplateHelper, 'name'>>(), cache = new Map<string, Renderer>()
  let frame: TemplateFrame | undefined, tokenRevision = 0
  const currentFrame = () => { if (!frame) throw new Error('template-render-frame-unavailable'); return frame }
  env.unregisterHelper('lookup'); env.unregisterHelper('log')
  env.registerHelper('eq', (a: unknown, b: unknown) => a === b)
  env.registerHelper('json', (value: unknown) => JSON.stringify(value))
  env.registerHelper('regexEscape', (value: unknown) => sanitizeRegexMacro(String(value)))
  env.registerHelper('each', function (this: unknown, value: unknown, options: unknown) {
    if (value === null || typeof value !== 'object' || !isEachOptions(options)) throw new Error('template-each-requires-collection')
    const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((child: unknown, index: number) => [index, child]) : Object.entries(value)
    if (!entries.length) return options.inverse(this)
    let text = ''
    for (let index = 0; index < entries.length; index++) {
      if (++currentFrame().iterations > maxIterations) throw new Error('template-loop-budget-exceeded')
      const [key, child] = entries[index]
      const data = { ...(options.data ?? {}), key, index, first: index === 0, last: index === entries.length - 1 }
      text += options.fn(child, { data, blockParams: [child, key] })
      if (text.length > maxOutputChars) throw new Error('template-output-too-large')
    }
    return text
  })
  function validate(source: string): string {
    if (typeof source !== 'string' || source.length > maxTemplateChars) throw new Error('template-too-large')
    const ast: unknown = env.parse(source)
    const visit = (node: unknown): void => {
      if (!isRecord(node)) return
      if (['Decorator', 'DecoratorBlock', 'RawBlock', 'PartialBlockStatement'].includes(String(node.type))) throw new Error('template-unsupported-directive')
      if (node.type === 'PathExpression' && Array.isArray(node.parts) && node.parts.some((part: unknown) => typeof part === 'string' && unsafe.has(part))) throw new Error('template-dangerous-path')
      if (['MustacheStatement', 'BlockStatement', 'SubExpression'].includes(String(node.type))) {
        const name = isRecord(node.path) ? String(node.path.original) : ''
        const hasParams = Array.isArray(node.params) && node.params.length > 0
        const hasHash = isRecord(node.hash) && Array.isArray(node.hash.pairs) && node.hash.pairs.length > 0
        if (disabledHelpers.has(name) || (hasParams || hasHash || node.type === 'BlockStatement' || node.type === 'SubExpression') && !allowed.has(name) && !helpers.has(name)) throw new Error(`template-helper-unavailable: ${name}`)
      }
      if (node.type === 'PartialStatement' && (!isRecord(node.name) || node.name.type !== 'PathExpression')) throw new Error('template-dynamic-partial-unavailable')
      for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child)
    }
    visit(ast)
    return source
  }
  function compiled(source: string): Renderer {
    let render = cache.get(source)
    if (!render) {
      render = env.compile(validate(source), { strict: true, noEscape: true, ignoreStandalone: true, knownHelpersOnly: false })
      cache.set(source, render)
      if (cache.size > 256) { const first = cache.keys().next().value; if (first !== undefined) cache.delete(first) }
    }
    return render
  }
  return {
    validate,
    fork() {
      const copy = createTemplates({ maxTemplateChars, maxOutputChars, maxIterations, maxPartialDepth })
      for (const [name, { revision, render }] of helpers) copy.registerHelper({ name, revision, render })
      for (const { name, revision, template } of partials.values()) copy.registerPartial({ name, revision, template })
      return copy
    },
    registerPartial({ name, revision, template }: TemplatePartial) {
      if (!name || !revision || partials.has(name)) throw new Error('template-partial-conflict')
      const render = compiled(template)
      const wrapped: Renderer = (context, options) => {
        const active = currentFrame()
        if (++active.partialDepth > maxPartialDepth) throw new Error('template-partial-depth-exceeded')
        try { return render(context, options) } finally { active.partialDepth-- }
      }
      partials.set(name, { name, revision, template, wrapped }); env.registerPartial(name, wrapped); tokenRevision++
      return () => { if (partials.get(name)?.wrapped === wrapped) { partials.delete(name); env.unregisterPartial(name); tokenRevision++ } }
    },
    registerHelper({ name, revision, render }: TemplateHelper) {
      if (!name || !revision || allowed.has(name) || helpers.has(name) || unsafe.has(name) || disabledHelpers.has(name)) throw new Error('template-helper-conflict')
      if (typeof render !== 'function') throw new Error('template-helper-render-required')
      helpers.set(name, { revision, render }); env.registerHelper(name, render); tokenRevision++
      return () => { if (helpers.get(name)?.render === render) { helpers.delete(name); env.unregisterHelper(name); tokenRevision++ } }
    },
    render(source: string, snapshot: unknown) {
      if (frame) throw new Error('template-reentrant-render')
      frame = { iterations: 0, partialDepth: 0 }
      try {
        const text = compiled(source)(frozenJson(snapshot), { allowProtoMethodsByDefault: false, allowProtoPropertiesByDefault: false })
        if (text.length > maxOutputChars) throw new Error('template-output-too-large')
        return text
      } finally { frame = undefined }
    },
    bind: (input: unknown, snapshot: unknown) => bindInputs(input, frozenJson(snapshot)),
    tokenRevision: () => tokenRevision,
    versions: () => ({ partials: [...partials].map(([name, value]) => ({ name, revision: value.revision })), helpers: [...helpers].map(([name, value]) => ({ name, revision: value.revision })) }),
  }
}
