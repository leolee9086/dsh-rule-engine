import { detectorValidator } from './detector-protocol.js'
import { isRecord } from './guard.js'

/** 扩展只编译声明，不拥有匹配/交付状态；产物由共同规则校验器再次检查。 */
export interface RuleExtension {
  ref: string
  revision: number
  paramsSchema: unknown
  compile(params: unknown): unknown
  title?: string
  description?: string
}
interface Contribution {
  declaration: RuleExtension
  validate(params: unknown): boolean
  errors(): unknown
  generation: number
}
export function createRuleExtensions() {
  const conditions = new Map<string, Contribution>(), actions = new Map<string, Contribution>()
  let generation = 0
  const observers = new Set<() => void>()
  const changed = () => { generation++; for (const observe of observers) observe() }
  const register = (catalog: Map<string, Contribution>, declaration: RuleExtension) => {
    if (!/^[\w.-]+:[\w.:-]+$/.test(declaration.ref) || !Number.isSafeInteger(declaration.revision) || declaration.revision < 1
      || typeof declaration.compile !== 'function') throw new TypeError('rule-extension-invalid-declaration')
    if (typeof declaration.paramsSchema !== 'boolean' && !isRecord(declaration.paramsSchema)) throw new TypeError('rule-extension-params-schema-required')
    const validate = detectorValidator(declaration.paramsSchema)
    const contribution: Contribution = { declaration: { ...declaration, paramsSchema: structuredClone(declaration.paramsSchema) }, validate, errors: () => validate.errors, generation: generation + 1 }
    catalog.set(declaration.ref, contribution); changed()
    return () => { if (catalog.get(declaration.ref) === contribution) { catalog.delete(declaration.ref); changed() } }
  }
  // 编译期间记录实际解析到的能力，包含扩展展开后继续引用的能力。
  let dependencies: Map<string, Contribution> | undefined
  const expand = (value: unknown, catalog: Map<string, Contribution>, trail: string[] = []): unknown => {
    if (!isRecord(value) || value.kind !== 'extension') return value
    if (Object.keys(value).some(key => !['kind', 'ref', 'revision', 'params', 'id', 'stage', 'enabledDefault', 'cooldownMs', 'dedupe', 'dependsOn', 'failurePolicy'].includes(key))) throw new Error('rule-extension-unknown-field')
    if (typeof value.ref !== 'string') throw new TypeError('rule-extension-ref-required')
    const found = catalog.get(value.ref)
    if (!found || found.declaration.revision !== value.revision) throw new Error(`rule-extension-unavailable:${value.ref}@${String(value.revision)}`)
    dependencies?.set(`${catalog === actions ? 'action' : 'condition'}:${value.ref}`, found)
    if (trail.length >= 16 || trail.includes(value.ref)) throw new Error('rule-extension-recursive-compilation')
    const params = value.params ?? null
    if (!found.validate(params)) throw new TypeError(`rule-extension-invalid-params:${value.ref}:${JSON.stringify(found.errors())}`)
    const result = expand(found.declaration.compile(structuredClone(params)), catalog, [...trail, value.ref])
    // Expansion cannot allocate hidden action IDs or replace a caller's dependency/control identity.
    if (catalog === actions) {
      if (!isRecord(result) || Array.isArray(result)) throw new TypeError('rule-extension-action-must-compile-to-one-action')
      const common = Object.fromEntries(['id', 'stage', 'enabledDefault', 'cooldownMs', 'dedupe', 'dependsOn', 'failurePolicy'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
      return { ...result, ...common }
    }
    return result
  }
  const condition = (value: unknown, depth = 0): unknown => {
    if (depth > 32) throw new Error('rule-extension-condition-depth')
    const expanded = expand(value, conditions)
    if (!isRecord(expanded)) return expanded
    if (expanded.kind === 'all' || expanded.kind === 'any') return { ...expanded, conditions: Array.isArray(expanded.conditions) ? expanded.conditions.map(child => condition(child, depth + 1)) : expanded.conditions }
    if (expanded.kind === 'not') return { ...expanded, condition: condition(expanded.condition, depth + 1) }
    return expanded
  }
  const compile = (input: unknown): unknown => {
    if (!isRecord(input)) return input
    return { ...input, ...(input.match === undefined ? {} : { match: condition(input.match) }),
      ...(isRecord(input.when) && input.when.condition !== undefined ? { when: { ...input.when, condition: condition(input.when.condition) } } : {}),
      ...(Array.isArray(input.actions) ? { actions: input.actions.map(action => {
        const expanded = expand(action, actions)
        return isRecord(expanded) && expanded.condition !== undefined ? { ...expanded, condition: condition(expanded.condition) } : expanded
      }) } : {}) }
  }
  const prepare = (input: unknown) => {
    const previous = dependencies, used = new Map<string, Contribution>()
    dependencies = used
    try {
      const value = compile(input)
      return { value, current: () => [...used].every(([key, contribution]) => (key.startsWith('action:') ? actions : conditions).get(contribution.declaration.ref) === contribution) }
    } finally {
      dependencies = previous
      if (previous) for (const [key, contribution] of used) previous.set(key, contribution)
    }
  }
  return {
    registerCondition: (declaration: RuleExtension) => register(conditions, declaration),
    registerAction: (declaration: RuleExtension) => register(actions, declaration),
    compile, prepare,
    token: () => generation,
    catalog: () => [...conditions].map(([ref, value]) => ({ kind: 'condition', ref, revision: value.declaration.revision, title: value.declaration.title, description: value.declaration.description, paramsSchema: structuredClone(value.declaration.paramsSchema) }))
      .concat([...actions].map(([ref, value]) => ({ kind: 'action', ref, revision: value.declaration.revision, title: value.declaration.title, description: value.declaration.description, paramsSchema: structuredClone(value.declaration.paramsSchema) }))),
    observe(observer: () => void) { observers.add(observer); return () => { observers.delete(observer) } },
    close() { conditions.clear(); actions.clear(); changed(); observers.clear() },
  }
}
