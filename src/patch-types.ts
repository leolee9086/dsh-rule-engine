/**
 * 文本补丁的数据形状。
 *
 * 一次性与增量补丁共用 createBlockPatchPlan 的校验、优先级决议和物化。
 * 这里定义其共同输入和结果；显示与请求只负责各自的坐标映射。
 */

/** 一块文本补丁：把 blockId 的 range 换成 text。 */
export interface BlockPatch {
  blockId: string
  actionId: string
  /** 决议优先级，大的先占位。 */
  priority: number
  /** UTF-16 半开区间。 */
  range: readonly number[]
  text: string
}

/** 一条补丁的处理结果。 */
export interface PatchResult {
  actionId: string
  /** planned / applied / skipped 之类的具体状态，由决议方定义。 */
  status: string
  /** skipped 时的原因。 */
  reason?: string
  blockId?: string
  before?: string
  after?: string
}

/** 一次补丁决议的产出。 */
export interface PatchOutput<B> {
  blocks: B[]
  results: PatchResult[]
}
