import type { BlockPatch, PatchResult, PatchOutput } from './patch-types.js'
import { materializeText } from './text-edits.js'
export function applyBlockPatches<B extends TextBlock>(blocks: readonly B[], patches: readonly BlockPatch[]): PatchOutput<B> {
  const plan = createBlockPatchPlan<B, BlockPatch>(blocks)
  plan.add(patches)
  return plan.finish()
}
interface TextBlock { id: string; text?: string; raw?: object; signed?: unknown; segments?: unknown }
interface Entry<P extends BlockPatch> { patch: P; order: number; active: boolean; queued: boolean; blocker?: Entry<P>; blocked: Set<Entry<P>> }
interface Interval<P extends BlockPatch> { entry: Entry<P>; best: Entry<P>; rank: number; max: number; left?: Interval<P>; right?: Interval<P> }
const compare = <P extends BlockPatch>(a: Entry<P>, b: Entry<P>) => b.patch.priority - a.patch.priority || a.patch.actionId.localeCompare(b.patch.actionId) || a.order - b.order
const rank = (value: number) => { value = Math.imul(value ^ value >>> 16, 0x45d9f3b); value = Math.imul(value ^ value >>> 16, 0x45d9f3b); return (value ^ value >>> 16) >>> 0 }

/** Accepted intervals only. A treap avoids scanning every old range, including
 * for zero-width insertions (the engine uses strict overlap at both ends). */
function intervals<P extends BlockPatch>(worked: (amount: number) => void) {
  let root: Interval<P> | undefined
  const key = (a: Entry<P>, b: Entry<P>) => a.patch.range[0] - b.patch.range[0] || a.order - b.order
  const update = (node: Interval<P>) => {
    node.max = Math.max(node.entry.patch.range[1], node.left?.max ?? -1, node.right?.max ?? -1); node.best = node.entry
    for (const child of [node.left, node.right]) if (child && compare(child.best, node.best) < 0) node.best = child.best
    return node
  }
  function merge(a?: Interval<P>, b?: Interval<P>): Interval<P> | undefined {
    if (!a || !b) return a ?? b
    if (a.rank < b.rank) { a.right = merge(a.right, b); return update(a) }
    b.left = merge(a, b.left); return update(b)
  }
  function split(node: Interval<P> | undefined, entry: Entry<P>): [Interval<P> | undefined, Interval<P> | undefined] {
    if (!node) return [undefined, undefined]
    if (key(node.entry, entry) < 0) { const [a, b] = split(node.right, entry); node.right = a; return [update(node), b] }
    const [a, b] = split(node.left, entry); node.left = b; return [a, update(node)]
  }
  function remove(node: Interval<P> | undefined, entry: Entry<P>): Interval<P> | undefined {
    if (!node) return undefined
    if (node.entry === entry) return merge(node.left, node.right)
    if (key(entry, node.entry) < 0) node.left = remove(node.left, entry); else node.right = remove(node.right, entry)
    return update(node)
  }
  return {
    add(entry: Entry<P>) { const [left, right] = split(root, entry); root = merge(merge(left, { entry, best: entry, rank: rank(entry.order + 1), max: entry.patch.range[1] }), right) },
    remove(entry: Entry<P>) { root = remove(root, entry) },
    blocker(entry: Entry<P>): Entry<P> | undefined {
      const [start, end] = entry.patch.range
      function visit(node?: Interval<P>): Entry<P> | undefined {
        if (!node || node.max <= start || compare(node.best, entry) >= 0) return undefined
        worked(1)
        const found = visit(node.left)
        if (found) return found
        const [from, to] = node.entry.patch.range
        if (from < end && to > start && compare(node.entry, entry) < 0) return node.entry
        return from < end ? visit(node.right) : undefined
      }
      return visit(root)
    },
    overlaps(start: number, end: number): Entry<P>[] {
      const found: Entry<P>[] = []
      function visit(node?: Interval<P>) {
        if (!node || node.max <= start) return
        worked(1); visit(node.left)
        const [from, to] = node.entry.patch.range
        if (from < end && to > start) found.push(node.entry)
        if (from < end) visit(node.right)
      }
      visit(root); return found
    },
  }
}

/** 模型、显示和一次性补丁共用同一决议器。被阻塞的区间跟随胜者，
 * 胜者被替换时只重审受影响的补丁；基线坐标始终不变。 */
export function createBlockPatchPlan<B extends TextBlock, P extends BlockPatch>(
  baseline: readonly B[], worked: (amount: number) => void = () => {}, same?: (id: string) => readonly B[],
) {
  const byId = new Map<string, B[]>()
  if (!same) for (const block of baseline) { const group = byId.get(block.id); if (group) group.push(block); else byId.set(block.id, [block]) }
  const groups = new Map<string, { rows: readonly B[]; index: ReturnType<typeof intervals<P>>; active: Set<Entry<P>> }>()
  const counts = new Map<string, number>(), committed: Entry<P>[] = []
  let serial = 0
  const count = (entry: Entry<P>, delta: number) => { const id = entry.patch.actionId, value = (counts.get(id) ?? 0) + delta; if (value) counts.set(id, value); else counts.delete(id) }
  const accept = (candidates: readonly P[], retainRejected = false): boolean => {
      if (!candidates.length) throw new Error('display-patch-empty-candidate')
      const id = candidates[0].blockId, actionId = candidates[0].actionId
      if (candidates.some(patch => patch.blockId !== id || patch.actionId !== actionId)) throw new Error('display-patch-mixed-candidate')
      let group = groups.get(id)
      if (!group) { group = { rows: same ? same(id) : byId.get(id) ?? [], index: intervals<P>(worked), active: new Set() }; groups.set(id, group) }
      const rows = group.rows, block = rows[0]
      const added: Entry<P>[] = candidates.map(patch => ({ patch, order: serial++, active: false, queued: false, blocked: new Set() }))
      // Validate the entire speculative batch before changing committed state,
      // in exactly the engine's order; even overlapping invalid patches throw.
      for (const { patch } of [...added].sort(compare)) {
        worked(1)
        if (!block) throw new Error('rules-v2: stale block anchor')
        if (block.signed || typeof block.text !== 'string') throw new Error('rules-v2: block cannot be text-patched')
        if (block.segments) throw new Error('rules-v2: cross-block replacement requires per-block patches')
        const [start, end] = patch.range
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > block.text.length) throw new Error('rules-v2: invalid patch range')
        if (typeof patch.text !== 'string') throw new TypeError('rules-v2: replacement must be text')
      }
      const queue: Entry<P>[] = []
      const enqueue = (entry: Entry<P>) => {
        if (entry.queued) return; entry.queued = true; queue.push(entry)
        let at = queue.length - 1
        while (at > 0) { const parent = (at - 1) >>> 1; if (compare(queue[parent], entry) <= 0) break; queue[at] = queue[parent]; at = parent }
        queue[at] = entry
      }
      const pop = () => {
        const first = queue[0], last = queue.pop()
        if (last === undefined) throw new Error('patch-plan-empty-ready-queue')
        if (queue.length) { let at = 0; while (at * 2 + 1 < queue.length) { let child = at * 2 + 1; if (child + 1 < queue.length && compare(queue[child + 1], queue[child]) < 0) child++; if (compare(last, queue[child]) <= 0) break; queue[at] = queue[child]; at = child } queue[at] = last }
        first.queued = false; return first
      }
      for (const entry of added) enqueue(entry)
      while (queue.length) {
        const entry = pop(), blocker = group.index.blocker(entry)
        if (entry.blocker) entry.blocker.blocked.delete(entry)
        entry.blocker = blocker
        if (blocker) { blocker.blocked.add(entry); continue }
        for (const old of group.index.overlaps(entry.patch.range[0], entry.patch.range[1])) {
          group.index.remove(old); group.active.delete(old); old.active = false; count(old, -1)
          old.blocker = entry; entry.blocked.add(old)
          for (const waiting of old.blocked) { waiting.blocker = undefined; enqueue(waiting) }
          old.blocked.clear()
        }
        group.index.add(entry); group.active.add(entry); entry.active = true; count(entry, 1)
      }
      // Original acceptance asks whether this action id is planned ANYWHERE,
      // not whether a newly submitted range won. Keep cross-block duplicates.
      if (!retainRejected && !counts.has(actionId)) {
        // No new candidate could have displaced an old winner: that would leave
        // at least one new range with this same action id planned. Detach losers.
        for (const entry of added) entry.blocker?.blocked.delete(entry)
        return false
      }
      committed.push(...added); return true
  }
  return {
    accept(candidates: readonly P[]): boolean { return accept(candidates) },
    /** 一次性提交保留被拒项的诊断；区间判断与增量提交完全共用。 */
    add(patches: readonly P[]): void {
      for (const patch of [...patches].sort((a, b) => b.priority - a.priority || a.actionId.localeCompare(b.actionId))) accept([patch], true)
    },
    finish(): PatchOutput<B> {
      const sorted = [...committed].sort(compare)
      const results: PatchResult[] = sorted.map(entry => {
        const patch = entry.patch
        if (!entry.active) return { actionId: patch.actionId, status: 'skipped', reason: 'overlapping-patch' }
        const block = groups.get(patch.blockId)?.rows[0]
        if (typeof block?.text !== 'string') throw new Error('patch-plan-active-text-unavailable')
        return { actionId: patch.actionId, status: 'planned', blockId: patch.blockId, before: block.text.slice(patch.range[0], patch.range[1]), after: patch.text }
      })
      const outputs = new Map<string, { rows: B[]; next: number }>()
      for (const [id, group] of groups) if (group.active.size) {
        const patches = [...group.active].sort((a, b) => b.patch.range[0] - a.patch.range[0] || compare(a, b)).map(entry => entry.patch)
        const rows = group.rows.map(block => {
          worked(1)
          const text = materializeText(block.text ?? '', patches)
          return { ...block, text, raw: { ...block.raw, text } }
        })
        outputs.set(id, { rows, next: 0 })
      }
      return { blocks: baseline.map(block => { const output = outputs.get(block.id); return output ? output.rows[output.next++] : block }), results }
    },
  }
}
