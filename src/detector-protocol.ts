import { Ajv, type ValidateFunction } from 'ajv'
import { Script } from 'node:vm'
import { isRecord } from './guard.js'

/** 所有跨 Worker 的检测器数据保留完整 JSON 语义。 */
export function assertDetectorJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 32) throw new Error('detector-json-depth-exceeded')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('detector-value-must-be-json')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('detector-value-must-be-plain-json')
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || !property?.enumerable || !Object.hasOwn(property, 'value')) throw new Error('detector-invalid-json-property')
    assertDetectorJson(property.value, depth + 1, seen)
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error('detector-sparse-array')
  seen.delete(value)
}
// 每个进程/Worker 只准备一次 Ajv 的 draft-07 元 schema。放在模块初始化阶段，
// 使默认 Worker 的 ready 回执覆盖这段冷启动，避免每个用户 schema 都重编元 schema、
// 消耗同一任务的匹配预算。用户 schema 的编译与验证仍在原来的工作预算内。
const compiler = new Ajv({ strict: true, allErrors: true, validateFormats: false })
compiler.validateSchema({})
// Ajv 的批量清理会同时移除 draft-07 的标准别名（字符串引用）；保存原始
// 元 schema 引用，清理用户定义后恢复，兼容显式 $schema 和默认 schema。
const metaReferences = { ...compiler.refs }

export function detectorValidator(schema: unknown, cache?: Map<string, ValidateFunction<unknown>>): ValidateFunction<unknown> {
  assertDetectorJson(schema)
  const key = JSON.stringify(schema)
  if (Buffer.byteLength(key, 'utf8') > 65536) throw new Error('detector-schema-budget-exceeded')
  const previous = cache?.get(key)
  if (previous && cache) { cache.delete(key); cache.set(key, previous); return previous }
  if (typeof schema !== 'boolean' && !isRecord(schema)) throw new Error('detector-schema-must-be-object-or-boolean')
  let validate: ValidateFunction<unknown>
  try { validate = compiler.compile<unknown>(schema) }
  finally {
    // 每份 schema 仍然独立：不允许借上次编译的 $id/$ref 解析另一份 schema，
    // 也不让 Ajv 的内部缓存绕过调用方已有的 16 项 LRU。已返回的验证函数有效。
    // 无参 removeSchema 只移除用户 schema，保留预编译的元 schema。
    compiler.removeSchema()
    Object.assign(compiler.refs, metaReferences)
  }
  if (cache) {
    const first = cache.keys().next().value
    if (cache.size >= 16 && first !== undefined) cache.delete(first)
    cache.set(key, validate)
  }
  return validate
}
export function validateDetectorValue(validate: ValidateFunction<unknown>, value: unknown, label: string, maxBytes: number): unknown {
  assertDetectorJson(value)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw new Error(`detector-${label}-budget-exceeded`)
  if (!validate(value)) throw new Error(`detector-${label}-schema-invalid`)
  return value
}
export type DetectorCallbackName = 'initialize' | 'feed' | 'finalize' | 'reset'
/**
 * 宿主进程回调：真正的函数对象，在本进程直接调用。
 *
 * 与 Worker 通路互斥。函数不序列化、不转源码——它就在宿主里跑，
 * 代价是失去 Worker 的隔离与超时保护，由注册者自己保证不写死循环。
 */
export type HostCallbacks = Record<DetectorCallbackName, (input: Record<string, unknown>) => unknown>
/**
 * Worker 进程回调：源码字符串，序列化后进 Worker 编译执行。
 *
 * 函数对象过不了进程边界，所以这条通路在接口上就要求源码：
 * 注册者必须知道自己的代码会在另一侧被重新编译。
 */
export type WorkerCallbacks = Record<DetectorCallbackName, string>
/** Worker 通路的源码校验：必须是可求值的函数表达式，长度受限。 */
export function detectorCode(source: unknown, name: DetectorCallbackName): string {
  if (typeof source !== 'string' || !source) throw new Error(`detector-code-required:${name}`)
  if (source.length > 65536) throw new Error('detector-code-budget-exceeded')
  try { new Script(`(${source})`) } catch { throw new Error('detector-code-invalid') }
  return source
}
/** 宿主通路注册时只收同步函数：异步回调无法在当前匹配回合内返回结果。 */
export function detectorHostCallback(callback: unknown, name: DetectorCallbackName): (input: Record<string, unknown>) => unknown {
  if (typeof callback !== 'function' || callback.constructor?.name !== 'Function') throw new Error(`detector-host-callback-must-be-synchronous:${name}`)
  return input => Reflect.apply(callback, undefined, [input])
}
export interface DetectorSpecification {
  plugin: string
  ref: string
  revision: number
  sessionId?: string
  on: string[]
  paramsSchema: unknown
  stateSchema: unknown
  resultSchema: unknown
  timeoutMs: number
  maxStateBytes: number
  maxResultBytes: number
  builtin?: string
  /** 宿主通路：函数在本进程直接调用。不进 Worker，不参与序列化。 */
  hostCallbacks?: HostCallbacks
  /** Worker 通路：源码字符串，进 Worker 编译执行。 */
  workerCallbacks?: WorkerCallbacks
}
export interface DetectorHeldState { state: unknown; offset: number; params: unknown; blockKey?: unknown }
export type DetectorStates = Record<string, DetectorHeldState>
