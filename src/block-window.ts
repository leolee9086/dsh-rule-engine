export interface BlockAddress { id: string; seq?: number; messageId?: string; turnId?: string }
export interface BlockProjection<T> { readonly length: number; at(index: number): T | undefined; slice(from: number, end: number): readonly T[] }
type Unit = 'message' | 'turn' | 'block'
interface RuleWindow { select: { depth?: { unit: Unit; limit: number } } }
interface Units { starts: number[]; seen: Set<string>; last?: string; repeatedAt?: number; missingAt?: number }
const emptyUnits = (): Units => ({ starts: [], seen: new Set() })
const before = (starts: readonly number[], end: number): number => {
  let left = 0, right = starts.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (starts[middle] < end) left = middle + 1
    else right = middle
  }
  return left
}

/** 一个来源的增量深度索引。宿主持有其生命周期，并提供替换 generation。
 * 深度先数身份再筛选角色/类型；非连续重复身份必须保留前缀，才能保持首次出现顺序。 */
export function createBlockWindow<T extends BlockAddress>() {
  let through = 0, generation: number | undefined
  let units: Record<Unit, Units> = { block: emptyUnits(), message: emptyUnits(), turn: emptyUnits() }
  let previous: { from: number; end: number; values: readonly T[] } | undefined
  return function select(source: BlockProjection<T>, rules: readonly RuleWindow[], maxSeq = Infinity, nextGeneration = 0): readonly T[] {
    if (generation !== nextGeneration) {
      generation = nextGeneration; through = 0; previous = undefined
      units = { block: emptyUnits(), message: emptyUnits(), turn: emptyUnits() }
    }
    const at = (index: number): T => {
      const block = source.at(index)
      if (!block) throw new Error('workbench-indexed-block-missing')
      return block
    }
    let end = source.length
    if (maxSeq !== Infinity) {
      let left = 0, right = end
      while (left < right) {
        const middle = Math.floor((left + right) / 2), seq = at(middle).seq
        if (seq === undefined) throw new Error('workbench-history-sequence-missing')
        if (seq <= maxSeq) left = middle + 1
        else right = middle
      }
      end = left
    }
    for (let index = through; index < end; index++) {
      const block = at(index), keys: Record<Unit, string | undefined> = { block: block.id, message: block.messageId, turn: block.turnId }
      for (const unit of ['block', 'message', 'turn'] as const) {
        const state = units[unit], key = keys[unit]
        if (key === undefined) { state.missingAt ??= index; continue }
        if (state.last === key) continue
        if (state.seen.has(key)) state.repeatedAt ??= index
        else { state.starts.push(index); state.seen.add(key) }
        state.last = key
      }
    }
    through = Math.max(through, end)
    let from = end
    for (const rule of rules) {
      const depth = rule.select.depth
      if (!depth) { from = 0; break }
      const state = units[depth.unit]
      if (state.missingAt !== undefined && state.missingAt < end) throw new Error(`rules-v2: ${depth.unit} identity unavailable`)
      if (state.repeatedAt !== undefined && state.repeatedAt < end) { from = 0; break }
      const count = before(state.starts, end)
      from = Math.min(from, state.starts[Math.max(0, count - depth.limit)] ?? end)
    }
    // 展示响应需要保留当前消息的全部子块，即使规则只匹配最后一个块。
    if (end) {
      const seq = at(end - 1).seq
      let left = 0, right = end
      while (left < right) {
        const middle = Math.floor((left + right) / 2)
        if (at(middle).seq === seq) right = middle
        else left = middle + 1
      }
      from = Math.min(from, left)
    }
    if (previous?.from === from && previous.end === end) return previous.values
    const values = source.slice(from, end)
    previous = { from, end, values }
    return values
  }
}
