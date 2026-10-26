/**
 * 正则的编译、替换与宏替换。
 *
 * 搬运自 SillyTavern 的正则扩展（参考项目\SillyTavern\public\scripts\extensions\regex\engine.js，
 * AGPL-3.0）。与本库的差异都写在对应函数的注释里：
 *
 *   1. 不 import 酒馆的全局脚本 —— 宏替换改成由调用方注入的函数；
 *   2. 替换回调里不做变量复用（酒馆那处会把 $1 的值漏给后面取不到的 $<name>）；
 *   3. **不做降级回退**。酒馆在好几处会把「说不清楚」的输入悄悄当成另一种意思 ——
 *      flag 非法就把整个输入当 pattern、正则编译不出来就当没命中、字符串不是字符串就返回空串。
 *      这里一律判为失败：写坏的东西应该立刻暴露，而不是静默地变成别的行为。
 */

import type { Macros } from './types.js'
import { isRecord } from './guard.js'

/** findRegex 里的宏怎么替换，照搬酒馆的 substitute_find_regex。 */
export const SUBSTITUTE_FIND_REGEX = Object.freeze({
  /** 不替换，findRegex 原样编译。 */
  NONE: 0,
  /** 先替换宏，再编译。 */
  RAW: 1,
  /** 先替换宏、再对宏的值做正则转义，再编译。 */
  ESCAPED: 2,
})

/** 宏替换模式。 */
export type SubstituteMode = (typeof SUBSTITUTE_FIND_REGEX)[keyof typeof SUBSTITUTE_FIND_REGEX]

/** 正则编译缓存的默认容量，照搬酒馆的 1000 条。 */
export const DEFAULT_REGEX_CACHE_SIZE = 1000

/** JS 认得的 flag。酒馆用的是 [gmixXsuUAJ]，里面 x X A J 并不是标准 flag，这里不跟。 */
const VALID_FLAGS = /^(?!.*?(.).*?\1)[dgimsuvy]+$/

/**
 * 默认的宏替换：什么都不做。
 * 注入 macros 时，签名是 (text, transform?) —— transform 存在时应当用它处理每个宏的值
 * （对应酒馆的 substituteParamsExtended 的第三个参数）。
 */
export const identityMacros: Macros = (text: string) => text

/**
 * 跑一次宏替换，并保证拿回来的是字符串。
 * 宏替换的结果直接进正则或进文本，返回别的东西一律是调用方的 bug，不能往下传。
 */
function applyMacros(macros: Macros, text: string, transform?: (value: string) => string): string {
  const out: unknown = transform === undefined ? macros(text) : macros(text, transform)
  if (typeof out !== 'string') {
    throw new TypeError('dsh-rule-engine: macros must return a string, got ' + typeof out)
  }
  return out
}

/**
 * 是不是 `/.../flags` 这种写法。
 * 用于 when.said / when.produced 这类「既可能是子串、也可能是正则」的字段。
 */
export function isRegexLiteral(pattern: string): boolean {
  return typeof pattern === 'string' && /^\/(.+)\/([a-z]*)$/is.test(pattern)
}

/**
 * 从字符串实例化正则。
 *
 * 支持 `/pattern/flags` 与裸 `pattern` 两种写法。
 * 规则里的正则必须是字符串而不是 RegExp 对象：规则要能跨边界传递、能序列化、能手写。
 *
 * 编译不出来时抛错，错误里带原始 pattern —— 调用方引用它时必须能追到是哪条规则。
 * 与酒馆的差异：flag 非法时酒馆会退回「把整个输入当 pattern」，
 * 于是 `/a/z` 会悄悄变成匹配 a/z 的正则。意图不清，宁可失败。
 */
export function regexFromString(input: string): RegExp {
  if (typeof input !== 'string') {
    throw new TypeError('dsh-rule-engine: regexFromString expects a string, got ' + typeof input)
  }
  if (input.length === 0) {
    throw new Error('dsh-rule-engine: regexFromString received an empty pattern')
  }
  const m = input.match(/(\/?)(.+)\1([a-z]*)/i)
  if (m === null) {
    throw new Error('dsh-rule-engine: not a regex: ' + JSON.stringify(input))
  }
  // flag 非法就是写错了，不猜它本来想干什么。
  if (m[3] && !VALID_FLAGS.test(m[3])) {
    throw new Error('dsh-rule-engine: invalid regex flags ' + JSON.stringify(m[3]) + ' in ' + JSON.stringify(input))
  }
  try {
    return new RegExp(m[2], m[3])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error('dsh-rule-engine: cannot compile regex ' + JSON.stringify(input) + ': ' + message, { cause: error })
  }
}

/**
 * 转义宏值里的正则元字符（照搬酒馆的 sanitizeRegexMacro）。
 * 用在 substituteRegex = ESCAPED 时：宏的值是普通文本，不该被当成正则。
 */
export function sanitizeRegexMacro(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError('dsh-rule-engine: sanitizeRegexMacro expects a string, got ' + typeof value)
  }
  return value.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\\/|()]/gs, function (s: string): string {
    switch (s) {
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\t': return '\\t'
      case '\v': return '\\v'
      case '\f': return '\\f'
      case '\0': return '\\0'
      default: return '\\' + s
    }
  })
}

/** global/sticky 正则自带 lastIndex 状态，复用前必须归零，否则第二次匹配会从中间开始。 */
function resetLastIndex(regex: RegExp): void {
  if (regex.global || regex.sticky) regex.lastIndex = 0
}

/**
 * 带 LRU 淘汰的正则缓存（照搬酒馆的 RegexProvider）。
 *
 * 为什么必须有：规则跑在请求热路径上，正则不能每次都重新编译；
 * 而规则条数没有上限，缓存也不能无界。
 *
 * 编译失败直接抛出包含原始 pattern 和底层原因的错误，不写入缓存。
 */
export class RegexProvider {
  readonly #cache = new Map<string, RegExp>()
  readonly #maxSize: number

  constructor(maxSize: number = DEFAULT_REGEX_CACHE_SIZE) {
    this.#maxSize = maxSize
  }

  /**
   * 取一条编译好的正则。编译不出来直接抛错，不返回 null。
   * @param regexString 正则字符串。
   * @returns 编译结果；非法时抛错（错误的 pattern 不会被悄悄当成「没命中」）。
   */
  get(regexString: string): RegExp {
    if (typeof regexString !== 'string') {
      throw new TypeError('dsh-rule-engine: RegexProvider.get expects a string, got ' + typeof regexString)
    }
    const cached = this.#cache.get(regexString)
    if (cached !== undefined) {
      // LRU：命中就挪到队尾（Map 保持插入顺序，队首就是最久没用的）。
      this.#cache.delete(regexString)
      this.#cache.set(regexString, cached)
      resetLastIndex(cached)
      return cached
    }
    const regex = regexFromString(regexString)
    if (this.#cache.size >= this.#maxSize) {
      const oldest = this.#cache.keys().next()
      if (!oldest.done) this.#cache.delete(oldest.value)
    }
    this.#cache.set(regexString, regex)
    resetLastIndex(regex)
    return regex
  }

  /** 清空缓存。 */
  clear(): void {
    this.#cache.clear()
  }

  /** 当前缓存条数。 */
  get size(): number {
    return this.#cache.size
  }
}

/** 默认缓存实例。调用方可以传自己的 provider，用于隔离或调容量。 */
export const defaultRegexProvider = new RegexProvider()

/** filterString 的可选项。 */
export interface FilterOptions {
  macros?: Macros
}

/**
 * 从匹配结果里剔掉 trimStrings（照搬酒馆的 filterString）。
 *
 * 用途：先匹配一大块（比如整段思考），再去掉里面不要的串 ——
 * 这样一条规则就能表达「整段保留，但把其中某些行删掉」。
 */
export function filterString(rawString: string, trimStrings?: readonly string[] | null, { macros = identityMacros }: FilterOptions = {}): string {
  if (typeof rawString !== 'string') {
    throw new TypeError('dsh-rule-engine: filterString expects a string, got ' + typeof rawString)
  }
  if (trimStrings === undefined || trimStrings === null) return rawString
  if (!Array.isArray(trimStrings)) {
    throw new TypeError('dsh-rule-engine: trimStrings must be an array of strings')
  }
  let finalString = rawString
  for (const trimString of trimStrings) {
    if (typeof trimString !== 'string') {
      throw new TypeError('dsh-rule-engine: trimStrings must be an array of strings')
    }
    // 空串会匹配每一个位置，写它的人多半是想写别的。
    if (trimString.length === 0) {
      throw new Error('dsh-rule-engine: trimStrings must not contain an empty string')
    }
    finalString = finalString.replaceAll(applyMacros(macros, trimString), '')
  }
  return finalString
}

/** runRegexScript / resolveFindRegex 读的规则字段。 */
export interface RegexScript {
  findRegex?: string
  replaceString?: string
  trimStrings?: readonly string[]
  substituteRegex?: number
  disabled?: boolean
}

/**
 * 按 substituteRegex 决定 findRegex 最终怎么编译。
 *
 * 判「命中没有」和「实际替换」必须走同一个函数 —— 否则 RAW / ESCAPED 模式下
 * 两边看到的正则不一样，会出现「判命中时说不命中、真要替换时又能替换」的分裂。
 */
export function resolveFindRegex(script: RegexScript, macros: Macros): string {
  const findRegex = script.findRegex
  if (typeof findRegex !== 'string') {
    throw new TypeError('dsh-rule-engine: findRegex must be a string')
  }
  switch (Number(script.substituteRegex ?? SUBSTITUTE_FIND_REGEX.NONE)) {
    case SUBSTITUTE_FIND_REGEX.NONE:
      return findRegex
    case SUBSTITUTE_FIND_REGEX.RAW:
      return applyMacros(macros, findRegex)
    case SUBSTITUTE_FIND_REGEX.ESCAPED:
      // 第二个参数是「怎么处理每个宏的值」——只有 ESCAPED 模式才需要。
      return applyMacros(macros, findRegex, sanitizeRegexMacro)
    default:
      throw new Error('dsh-rule-engine: unknown substituteRegex ' + JSON.stringify(script.substituteRegex))
  }
}

/** runRegexScript 的可选项。 */
export interface RunOptions {
  macros?: Macros
  provider?: RegexProvider
}

/**
 * 对一段文本跑一条规则的正则替换（照搬酒馆的 runRegexScript）。
 *
 * 替换语法：
 *   - `$1`..`$n`：第 n 个捕获组
 *   - `$<name>`：具名捕获组
 *   - `{{match}}`：整段匹配（等价于 `$0`）
 *   - 取不到的占位符替换成空串
 * 替换结果整体再过一遍宏替换（酒馆的 substituteParams）。
 *
 * 与酒馆的差异：正则编译不出来时抛错，不当成「没命中」——
 * 一条写坏的规则静默失效，比它直接报错危险得多。
 */
export function runRegexScript(script: RegexScript, rawString: string, { macros = identityMacros, provider = defaultRegexProvider }: RunOptions = {}): string {
  if (script === undefined || script === null || typeof script !== 'object') {
    throw new TypeError('dsh-rule-engine: runRegexScript expects a rule object')
  }
  if (script.disabled !== undefined && typeof script.disabled !== 'boolean') {
    throw new TypeError('dsh-rule-engine: disabled must be a boolean')
  }
  if (script.disabled === true) return rawString
  if (typeof rawString !== 'string') {
    throw new TypeError('dsh-rule-engine: runRegexScript expects a string, got ' + typeof rawString)
  }
  if (typeof script.findRegex !== 'string') {
    throw new TypeError('dsh-rule-engine: findRegex must be a string')
  }
  // replaceString 省略和空串是两回事：省略是「没说」，空串是「换成空」。
  const template = script.replaceString
  if (typeof template !== 'string') {
    throw new TypeError('dsh-rule-engine: replaceString must be a string (use "" to delete the match)')
  }
  const findRegex = provider.get(resolveFindRegex(script, macros))

  return rawString.replace(findRegex, function (match: string, ...rest: unknown[]): string {
    // 酒馆用 [...arguments] 取参：args[0] 是整段匹配，args[1..] 是捕获组，
    // 末尾多出来的是 offset / 整串 / 具名组对象。这里保持同样的索引方式。
    const args: unknown[] = [match, ...rest]
    const last = args[args.length - 1]
    const groups = isRecord(last) ? last : undefined
    const replaceString = template.replace(/{{match}}/gi, '$0')
    const replaced = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_match: string, num?: string, groupName?: string): string => {
      const value: unknown = num !== undefined ? args[Number(num)] : groups?.[groupName ?? '']
      if (value === undefined || value === null) return ''
      // 捕获组的值先剔掉 trimStrings，再放进替换结果。
      return filterString(typeof value === 'string' ? value : String(value), script.trimStrings, { macros })
    })
    // 宏替换放在最后：替换结果里出现的 {{user}} 这类宏也要能用。
    return applyMacros(macros, replaced)
  })
}
