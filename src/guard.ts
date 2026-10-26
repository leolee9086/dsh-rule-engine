/**
 * 类型收窄函数。
 *
 * 本库不用 `as` 断言：每个从 unknown 到具体类型的转换都必须先被这些守卫证明过。
 * 这样「类型可信」的原因永远写在代码里，而不是写在断言上。
 */

/** 判定是不是普通对象（非 null、非数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判定是不是数组。
 * 收窄成 unknown[] 而不是 any[]：元素仍然要逐个证明。
 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** 判定是不是字符串数组。 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
