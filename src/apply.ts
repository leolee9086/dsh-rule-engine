/**
 * 把规则集作用在一段文本上。
 *
 * 纯函数：同样的输入必然得到同样的输出（正则缓存只是加速，不影响结果）。
 * 这一层不知道时间、不知道谁在消费 —— 冷却、surface 去重、消费者路由都在 engine.ts。
 */

import { matchRule, type MatchContext } from './match.js'
import { defaultRegexProvider, type RegexProvider } from './regex.js'
import { transformText } from './text-transform.js'
import { cacheLossRatio } from './budget.js'
import type { Gate, Hit, Macros, NormalizedRule, Surface } from './types.js'

/** applyRules 的入参。 */
export interface ApplyInput {
  /** 规范化并排好序的规则。 */
  rules: readonly NormalizedRule[]
  /** 待处理的一段文本。 */
  surface: Surface
  /** 会话级上下文。 */
  ctx?: MatchContext
  /** 最近一次同接口请求的文本；用来算这次变换的缓存代价。 */
  previous?: string | null
  /** 宏替换。 */
  macros?: Macros
  /** 正则缓存。 */
  provider?: RegexProvider
  /** 额外的准入判定。冷却、surface 去重这类有状态的判断由 engine 注入。 */
  gate?: Gate
}

/** applyRules 的结果。 */
export interface ApplyOutput {
  /** 变换后的文本。 */
  text: string
  /** 命中记录。 */
  hits: Hit[]
}

/**
 * 把规则集作用在一段文本上。
 *
 * 纯函数：同样的输入必然得到同样的输出（正则缓存只是加速，不影响结果）。
 * 这一层不知道时间、不知道谁在消费 —— 冷却、surface 去重、消费者路由都在 engine.ts。
 */
export function applyRules({ rules, surface, ctx = {}, previous = null, macros, provider = defaultRegexProvider, gate }: ApplyInput): ApplyOutput {
  if (!Array.isArray(rules)) {
    throw new TypeError('dsh-rule-engine: applyRules expects rules to be an array')
  }
  if (typeof surface !== 'object' || surface === null) {
    throw new TypeError('dsh-rule-engine: applyRules expects a surface object')
  }
  if (typeof surface.text !== 'string') {
    throw new TypeError('dsh-rule-engine: surface.text must be a string (use "" when there is no text)')
  }
  if (gate !== undefined && typeof gate !== 'function') {
    throw new TypeError('dsh-rule-engine: gate must be a function')
  }
  const baseline = surface.text
  let text = baseline
  const hits: Hit[] = []
  for (const rule of rules) {
    // 同步文本路径只接声明过的单动作，多动作在同一引擎的阶段路径执行。
    const action = rule.action
    if (action.kind === 'sequence') continue
    const current: Surface = { ...surface, text }
    const verdict = matchRule(rule, current, ctx, { provider, macros })
    if (!verdict.ok) continue
    if (gate !== undefined) {
      const allowed = gate(rule, current)
      if (allowed !== undefined) {
        if (typeof allowed !== 'object' || allowed === null || typeof allowed.ok !== 'boolean') {
          throw new TypeError('dsh-rule-engine: gate must return undefined or { ok: boolean, outcome?, detail? }')
        }
        if (!allowed.ok) {
          hits.push({
            ruleId: rule.id,
            kind: action.kind,
            placement: surface.placement,
            applied: false,
            outcome: allowed.outcome,
            detail: allowed.detail,
          })
          continue
        }
      }
    }
    if (action.kind === 'transform') {
      const next = transformText(rule.when, text, macros, provider, true).text
      // 代价按「这条规则自己造成的增量」算：前面几条已经改过的地方不该重复计入。
      const loss = cacheLossRatio(previous, baseline, next) - cacheLossRatio(previous, baseline, text)
      const budget = rule.budget
      if (loss > budget.maxCacheLoss) {
        hits.push({
          ruleId: rule.id,
          kind: 'transform',
          placement: surface.placement,
          applied: false,
          outcome: 'over-budget',
          detail: '这条规则要废掉 ' + (loss * 100).toFixed(2) + '% 的缓存，超过它自己的预算 ' + (budget.maxCacheLoss * 100).toFixed(2) + '%',
          loss,
          action: action,
        })
        continue
      }
      hits.push({
        ruleId: rule.id,
        kind: 'transform',
        placement: surface.placement,
        applied: true,
        changed: next !== text,
        loss,
        action: action,
      })
      text = next
    } else {
      hits.push({
        ruleId: rule.id,
        kind: 'notify',
        placement: surface.placement,
        applied: true,
        changed: false,
        loss: 0,
        action: action,
      })
    }
  }
  return { text, hits }
}
