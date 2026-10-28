const requestFields = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop', 'system', 'tools', 'messages']

/** Capture the complete public JSON estimate, preserving its original field order. */
export function publicRequestBytes(request: object): Buffer {
  const fields: [string, unknown][] = []
  // 只读取公共字段；私有句柄可以有 getter，计量不应触碰它。
  for (const key of requestFields) {
    const value: unknown = Reflect.get(request, key)
    if (value !== undefined) fields.push([key, value])
  }
  return Buffer.from(JSON.stringify(Object.fromEntries(fields)), 'utf8')
}

/** Compare complete payload bytes supplied by the environment's serializer. */
export function requestImpact<T extends object>(before: T, after: T, bytes: (request: T) => Buffer = publicRequestBytes) {
  const original = bytes(before), transformed = before === after ? original : bytes(after)
  let commonPrefixBytes = 0
  while (commonPrefixBytes < Math.min(original.length, transformed.length) && original[commonPrefixBytes] === transformed[commonPrefixBytes]) commonPrefixBytes++
  return { basis: 'public-request-json-estimate', providerSerialization: 'unknown', cacheHitTokens: null,
    beforeBytes: original.length, afterBytes: transformed.length, commonPrefixBytes,
    firstChangedByte: original.equals(transformed) ? null : commonPrefixBytes,
    changedSuffixBytes: Math.max(original.length, transformed.length) - commonPrefixBytes }
}

/** Round the environment's whole-message token estimate after validating it. */
export function estimateInjection<M>(message: M, estimateMessage?: (message: M) => number): number | null {
  if (!estimateMessage) return null
  const value = estimateMessage(message)
  if (!Number.isFinite(value) || value < 0) throw new Error('injection-token-estimate-invalid')
  return Math.ceil(value)
}
