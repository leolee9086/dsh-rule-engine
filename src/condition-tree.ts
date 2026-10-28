import { z } from 'zod'

export type BooleanCondition<Leaf> = Leaf
  | { kind: 'all'; conditions: BooleanCondition<Leaf>[] }
  | { kind: 'any'; conditions: BooleanCondition<Leaf>[] }
  | { kind: 'not'; condition: BooleanCondition<Leaf> }

/** 受约束的接收范围和完整条件树共用语法、深度与节点预算，只替换允许的叶节点。 */
export function conditionTree<Leaf>(leaf: (depth: number) => z.ZodType<Leaf>, { minChildren = 0, maxNodes }: { minChildren?: number; maxNodes?: number } = {}) {
  const levels = new Map<number, z.ZodType<BooleanCondition<Leaf>>>()
  const at = (depth: number): z.ZodType<BooleanCondition<Leaf>> => {
    const cached = levels.get(depth)
    if (cached) return cached
    if (depth > 16) return z.never({ error: 'condition depth exceeds 16' })
    const child = z.lazy(() => at(depth + 1))
    const schema: z.ZodType<BooleanCondition<Leaf>> = z.union([
      z.object({ kind: z.literal('all'), conditions: z.array(child).min(minChildren).max(64) }).strict(),
      z.object({ kind: z.literal('any'), conditions: z.array(child).min(minChildren).max(64) }).strict(),
      z.object({ kind: z.literal('not'), condition: child }).strict(), leaf(depth),
    ])
    levels.set(depth, schema)
    return schema
  }
  const schema = at(0).superRefine((root, context) => {
    if (maxNodes === undefined) return
    let nodes = 0
    const visit = (node: BooleanCondition<Leaf>): void => {
      if (++nodes > maxNodes) return
      if (node && typeof node === 'object' && 'kind' in node) {
        if ((node.kind === 'all' || node.kind === 'any') && 'conditions' in node && Array.isArray(node.conditions)) node.conditions.forEach(visit)
        else if (node.kind === 'not' && 'condition' in node) visit(node.condition)
      }
    }
    visit(root)
    if (nodes > maxNodes) context.addIssue({ code: 'custom', message: `condition exceeds ${maxNodes} nodes` })
  })
  return { schema, at }
}
