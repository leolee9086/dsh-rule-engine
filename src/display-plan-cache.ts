import type { PlanningCachePort } from './planning-cache.js'
import { indexDisplayBlocks, type DisplayBlockIdentity } from './display-index.js'
import { indexFirstRules } from './request-rule-index.js'
import { indexRequestActions, type RequestActionDependency, type RequestActionStages } from './request-action-order.js'

interface RuleIdentity { sourceId: string; id: string }
interface BlockEntry<B extends DisplayBlockIdentity> { blocks: readonly B[]; value: ReturnType<typeof indexDisplayBlocks<B>> }
interface RuleEntry<R extends RuleIdentity> { rules: readonly R[]; value: ReadonlyMap<string, R> }
interface ActionEntry<A extends RequestActionDependency> { actions: readonly A[]; value: RequestActionStages<A> }

// 每个缓存项保留其输入数组身份；泛型读取只检查身份，不重扫动作或块。
function blocksFor<B extends DisplayBlockIdentity>(entry: BlockEntry<DisplayBlockIdentity>, blocks: readonly B[]): entry is BlockEntry<B> { return entry.blocks === blocks }
function rulesFor<R extends RuleIdentity>(entry: RuleEntry<RuleIdentity>, rules: readonly R[]): entry is RuleEntry<R> { return entry.rules === rules }
function actionsFor<A extends RequestActionDependency>(entry: ActionEntry<RequestActionDependency>, actions: readonly A[]): entry is ActionEntry<A> { return entry.actions === actions }

/** 引擎定义单次显示规划的可重建目录；Host 持有缓存存储、统计与释放。 */
export function createDisplayPlanCache(cache: PlanningCachePort) {
  let closed = false
  const active = () => { if (closed) throw new Error('display-plan-cache-closed') }
  const blocksKey = cache.define<readonly DisplayBlockIdentity[], BlockEntry<DisplayBlockIdentity>>('display-plan-blocks',
    'Immutable display block cut within one synchronous planning operation.', blocks => {
      const value = indexDisplayBlocks(blocks); cache.worked(blocksKey, blocks.length); return { blocks, value }
    })
  const rulesKey = cache.define<readonly RuleIdentity[], RuleEntry<RuleIdentity>>('display-plan-rules',
    'First exact rule identity in this display operation, never rule decisions.', rules => {
      const value = indexFirstRules(rules); cache.worked(rulesKey, rules.length); return { rules, value }
    })
  const actionsKey = cache.define<readonly RequestActionDependency[], ActionEntry<RequestActionDependency>>('display-plan-actions',
    'Immutable action structure within this display operation; each evidence owns outcomes.', actions => {
      const value = indexRequestActions([...new Set(actions.filter(action => action.stage === 'display.render'))]); cache.worked(actionsKey, actions.length); return { actions, value }
    })
  const patchesKey = cache.define<object, never>('display-plan-patches',
    'New patch validation, affected interval visits and final materialized rows in this synchronous operation.', () => { throw new Error('display-patch-work-is-not-a-projection') })
  return {
    patchWork(amount: number) { active(); cache.worked(patchesKey, amount) },
    blocks<B extends DisplayBlockIdentity>(blocks: readonly B[]) {
      active(); const entry = cache.use(blocks, blocksKey)
      if (!blocksFor(entry, blocks)) throw new Error('display-block-index-identity-mismatch')
      return entry.value
    },
    rules<R extends RuleIdentity>(rules: readonly R[]) {
      active(); const entry = cache.use(rules, rulesKey)
      if (!rulesFor(entry, rules)) throw new Error('display-rule-index-identity-mismatch')
      return entry.value
    },
    actions<A extends RequestActionDependency>(actions: readonly A[]) {
      active(); const entry = cache.use(actions, actionsKey)
      if (!actionsFor(entry, actions)) throw new Error('display-action-index-identity-mismatch')
      return entry.value
    },
    close() { if (!closed) { closed = true; cache.clear(blocksKey); cache.clear(rulesKey); cache.clear(actionsKey); cache.clear(patchesKey) } },
  }
}
