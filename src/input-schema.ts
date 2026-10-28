import { z } from 'zod'
import { parseOrThrow } from './schema-error.js'

/** 规则、Worker 和持久化边界使用相同的基础 schema。 */
export const InputRecord = z.record(z.string(), z.unknown())
export const Identifier = z.string().min(1).max(256)
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
export function pathParts(path: string): string[] {
  return path.startsWith('/') ? path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')) : path.split('.')
}
export const Field = z.string().min(1).max(1024).refine(path => pathParts(path).every(part => part && !forbidden.has(part)), 'invalid field path: forbidden or empty segment')

/** z.json 定义值类型；这一层补充跨队列所需的所有权约束，解析前拦截环和 accessor。 */
export const OwnedJson = z.unknown().superRefine((root, context) => {
  const ancestors = new Set<object>()
  const visit = (value: unknown, depth: number): void => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    if (depth > 32) { issue('exceeds JSON nesting limit'); return }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return
    if (typeof value !== 'object' || value === null || ancestors.has(value)) { issue('must be acyclic JSON'); return }
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { issue('must be plain JSON'); return }
    ancestors.add(value)
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || forbidden.has(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) { issue('invalid JSON property'); continue }
      const child: unknown = descriptor.value
      visit(child, depth + 1)
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) issue('must be a dense array')
    ancestors.delete(value)
  }
  visit(root, 0)
}).pipe(z.json())

export const BoundJson = OwnedJson.superRefine((root, context) => {
  const visit = (value: z.infer<typeof OwnedJson>): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    if (Object.hasOwn(value, 'bind')) {
      if (Object.keys(value).length !== 1) context.addIssue({ code: 'custom', message: 'binding only accepts bind' })
      const result = Field.safeParse(value.bind)
      if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: 'custom', message: issue.message })
    } else Object.values(value).forEach(visit)
  }
  visit(root)
})
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, label: string): z.output<S> {
  return parseOrThrow('dsh-rule-engine: ' + label, () => schema.parse(input))
}
