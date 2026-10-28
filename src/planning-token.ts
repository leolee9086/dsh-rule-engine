import { isRecord } from './guard.js'

/** 在一次同步规划内复用精确策略 token；stamp 只用于失效，不能代替策略相等。 */
export function withPlanningToken<T>(expected: string, readStamp: () => readonly unknown[], readToken: () => string, run: (current: () => boolean) => T): T {
  let active = true, previous: readonly unknown[] | undefined, matches = false
  const current = (): boolean => {
    if (!active) throw new Error('planning-token-pass-closed')
    const next = readStamp()
    if (!previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous?.[index]))) {
      // 失败读取不发布 stamp，显式重试仍检查相同拥有者。
      const result = readToken() === expected
      previous = next; matches = result
    }
    return matches
  }
  try {
    const result = run(current)
    if ((isRecord(result) || typeof result === 'function') && 'then' in result && typeof result.then === 'function') throw new Error('planning-token-pass-must-be-synchronous')
    return result
  } finally { active = false; previous = undefined }
}
