import { z } from 'zod'
import { isRecord } from './guard.js'
import { runRegexScript, resolveFindRegex, defaultRegexProvider, identityMacros, type RegexProvider } from './regex.js'
import type { Macros } from './types.js'
import type { RegexScript } from './regex.js'
import { parseInput } from './input-schema.js'

/** 同一动作计划中的文本策略。规则选择与动作身份由外层计划拥有。 */
export const TextTransformFields = z.object({
  findRegex: z.string(), replaceString: z.string(), substituteRegex: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  trimStrings: z.array(z.string().min(1)),
}).strict()
export function validateTextRegex(value: Partial<z.infer<typeof TextTransformFields>>, context: z.RefinementCtx) {
  if (value.findRegex === undefined || (value.substituteRegex ?? 0) !== 0) return
  try { defaultRegexProvider.get(value.findRegex) }
  catch (error) { context.addIssue({ code: 'custom', path: ['findRegex'], message: error instanceof Error ? error.message : String(error) }) }
}
export const TextTransform = TextTransformFields.extend({
  substituteRegex: TextTransformFields.shape.substituteRegex.default(0), trimStrings: TextTransformFields.shape.trimStrings.default([]),
}).superRefine(validateTextRegex)
export type TextTransformValue = z.infer<typeof TextTransform>
export function normalizeTextTransform(value: unknown): TextTransformValue {
  return parseInput(TextTransform, value, 'text transform')
}
/** 宏绑定复用公共快照；带转义标记时由查找宏的规则确定转义方式。 */
export function snapshotMacros(snapshot: Record<string, unknown>): Macros {
  return (text, transform) => text.replace(/{{(?!match\b)([\w.]+)}}/gi, (whole: string, field: string) => {
    let value: unknown = snapshot
    for (const part of field.split('.')) {
      if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new TypeError('text-transform-forbidden-macro')
      value = isRecord(value) ? value[part] : undefined
    }
    return value === undefined || value === null ? whole : transform ? transform(String(value)) : String(value)
  })
}
export function transformText(transform: RegexScript, text: string, macros: Macros = identityMacros, provider: RegexProvider = defaultRegexProvider, matched = false) {
  // 同步入口已完成匹配，不能额外调用一次可能读取实时值的宏。
  if (!matched && !provider.get(resolveFindRegex(transform, macros)).test(text)) return { matched: false, text }
  return { matched: true, text: runRegexScript(transform, text, { macros, provider }) }
}
