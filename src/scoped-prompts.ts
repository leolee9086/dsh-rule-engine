import { z } from 'zod'
import { OutputPatternConfig } from './output-patterns.js'

/** 精确路由的提醒声明；Host 负责把最终片段放进原生请求。 */
export const ScopedPromptConfig = z.object({
  ruleId: z.string().min(1), version: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  purposes: z.array(z.enum(['conversation', 'compaction', 'session-title'])).min(1).default(['conversation']),
  trigger: z.enum(['static', 'model-switch', 'output-pattern']), initialBind: z.boolean().default(false), text: z.string().min(1),
  detector: OutputPatternConfig.optional(), carryFromOtherRoute: z.boolean().default(false),
}).strict().superRefine((rule, ctx) => {
  if ((rule.trigger === 'output-pattern') !== (rule.detector !== undefined)) ctx.addIssue({ code: 'custom', message: 'detector is required only for output-pattern' })
  if (rule.trigger === 'output-pattern' && (rule.purposes.length !== 1 || rule.purposes[0] !== 'conversation')) {
    ctx.addIssue({ code: 'custom', message: 'output-pattern observes conversation output only' })
  }
})
export type ScopedPrompt = z.output<typeof ScopedPromptConfig>
export function resolveScopedPrompts(input: unknown = []): ScopedPrompt[] {
  const rules = z.array(ScopedPromptConfig).parse(input), ids = new Set<string>()
  for (const rule of rules) {
    if (ids.has(rule.ruleId)) throw new Error(`context-care: duplicate scoped prompt ${rule.ruleId}`)
    ids.add(rule.ruleId)
  }
  return rules
}
export function selectScopedPrompts(rules: readonly ScopedPrompt[], request: { provider: string; model: string; purpose?: string },
  previousRoute?: { provider: string; model: string }) {
  const purpose = request.purpose ?? 'conversation'
  return rules.filter(rule => rule.provider === request.provider && rule.model === request.model && rule.purposes.some(value => value === purpose)
    && (rule.trigger === 'static' || (rule.trigger === 'model-switch' && (previousRoute === undefined ? rule.initialBind
      : previousRoute.provider !== request.provider || previousRoute.model !== request.model)))).map(rule => ({
      ruleId: rule.ruleId, version: rule.version, trigger: rule.trigger, provider: request.provider, model: request.model, purpose,
      text: rule.text.replaceAll('{boundModelLabel}', `${request.provider}/${request.model}`),
    }))
}
