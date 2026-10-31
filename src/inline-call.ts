/**
 * 规则自带代码的编译与状态。
 *
 * judge、detector、analyzer 三处都允许声明源码而不是外部模块，这里只写一份：
 * 源码用 `Function` 构造（不走模块解析、不需要文件），state 按源码哈希共享。
 *
 * 不用类型断言：构造器经 Reflect 拿到、用 typeof 收窄，满足项目 `assertionStyle: never`。
 */

/** 编译后的调用形态：同步与异步都返回 unknown，由调用方 await。 */
export type InlineCall = (ctx: unknown) => unknown

const compiled = new Map<string, InlineCall>()
const states = new Map<string, Map<string, unknown>>()

function hashOf(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  return (hash >>> 0).toString(16)
}

/** 同一段源码只编译一次；源码改一个字就是另一份实例。 */
export function compileInline(code: string): InlineCall {
  const cached = compiled.get(code)
  if (cached) return cached
  const holder: { run?: unknown } = {}
  // 换行包裹：code 末尾的行注释不能把外层的 `)(ctx)` 吞掉。
  const body = `holder.run = function (ctx) { return (\n${code}\n)(ctx) }\n//# sourceURL=inline://${hashOf(code)}`
  const build: unknown = Reflect.construct(globalThis.Function, ['holder', body])
  if (typeof build !== 'function') throw new Error('reminder-inline-compile-failed')
  build.call(undefined, holder)
  const run = holder.run
  if (typeof run !== 'function') throw new Error('reminder-inline-compile-failed')
  const call: InlineCall = ctx => Reflect.apply(run, undefined, [ctx])
  compiled.set(code, call)
  return call
}

/** 同一段源码共享一份状态；只在 Worker 存活期间持续，不落盘。 */
export function stateOf(code: string): Map<string, unknown> {
  const held = states.get(code)
  if (held) return held
  const created = new Map<string, unknown>()
  states.set(code, created)
  return created
}
