export interface DisplayBlockIdentity { id: string; view: string; path: string }
export interface DisplayInsertion<B> { at: number; priority: number; block: B }

/** 每个展示切面保留全部重复行，同时维护第一个锚点与路径子树目录。 */
export function indexDisplayBlocks<B extends DisplayBlockIdentity>(blocks: readonly B[]) {
  const baseline = blocks.filter(block => block.view === 'display'), first = new Map<string, number>(), ids = new Map<string, number[]>()
  baseline.forEach((block, index) => {
    if (!first.has(block.id)) first.set(block.id, index)
    let group = ids.get(block.id)
    if (!group) { group = []; ids.set(block.id, group) }
    group.push(index)
  })
  let descendants: Map<string, number[]> | undefined
  const filterGroups = new Map<B, readonly B[]>(), sameIds = new Map<string, readonly B[]>()
  return { baseline,
    same(id: string): readonly B[] {
      let group = sameIds.get(id)
      if (!group) { group = (ids.get(id) ?? []).map(index => baseline[index]); sameIds.set(id, group) }
      return group
    },
    first(id: string): B | undefined { const at = first.get(id); return at === undefined ? undefined : baseline[at] },
    position(id: string): number { return first.get(id) ?? -1 },
    filterGroup(block: B): readonly B[] {
      if (block.path === '$result') return baseline
      const cached = filterGroups.get(block)
      if (cached) return cached
      if (!descendants) {
        const directory = new Map<string, number[]>()
        baseline.forEach((candidate, index) => {
          let end = candidate.path.indexOf('.')
          while (end >= 0) {
            const prefix = candidate.path.slice(0, end)
            let group = directory.get(prefix)
            if (!group) { group = []; directory.set(prefix, group) }
            group.push(index); end = candidate.path.indexOf('.', end + 1)
          }
        })
        descendants = directory
      }
      const same = ids.get(block.id) ?? [], nested = descendants.get(block.path) ?? [], group: B[] = []
      let left = 0, right = 0
      while (left < same.length || right < nested.length) {
        const a = same[left] ?? Infinity, b = nested[right] ?? Infinity, index = Math.min(a, b)
        group.push(baseline[index]); if (a === index) left++; if (b === index) right++
      }
      filterGroups.set(block, group)
      return group
    },
  }
}

/** 反向遍历原有降序排序，保留相同锚点的插入顺序，一次合并输出。 */
export function mergeDisplayInsertions<B extends { id: string }>(baseline: readonly B[], insertions: readonly DisplayInsertion<B>[]): B[] {
  const sorted = [...insertions].sort((a, b) => b.at - a.at || a.priority - b.priority || b.block.id.localeCompare(a.block.id))
  const output: B[] = []
  let next = sorted.length - 1
  for (let at = 0; at <= baseline.length; at++) {
    while (next >= 0 && sorted[next].at === at) output.push(sorted[next--].block)
    if (at < baseline.length) output.push(baseline[at])
  }
  return output
}
