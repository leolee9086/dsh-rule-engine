/**
 * 引擎：把纯函数那一层接到有状态的生命周期上。
 *
 * 这一层管四件事，它们都需要状态：
 *   1. 规则来源 —— 静态配置 + 运行时由别的插件提供
 *   2. 消费者注册 —— 谁消费哪种动作，按 action.by 找
 *   3. 冷却与 surface 去重 —— 时间上的「多久没跑过」，和上下文里的「有没有过」，这是两回事
 *   4. 命中日志 —— 哪条规则、什么位置、代价多少、结果如何
 *
 * 「变换必须留下记录」：每条记录都交给 onRecord 回调，由宿主写成一条 agent 看不到的
 * session 事件。库本身不依赖 DSH，所以这里只给回调，不碰会话。
 */
import { normalizeRules, sortRules, isActionKind } from './rules.js'
import { applyRules } from './apply.js'
import { isUnknownArray } from './guard.js'
import type { RegexProvider } from './regex.js'
import type { MatchContext, MatchSurface } from './match.js'
import type { ActionKind, GateVerdict, Hit, Macros, NormalizedRule, RuleAction, Surface } from './types.js'

/** oncePerSurface 的记忆上限：超了就丢最老的，免得长期会话里无限增长。 */
const MAX_SURFACE_MEMORY = 500

/** 交给消费者的动作负载。 */
export interface DeliveryPayload {
  ruleId: string
  kind: ActionKind
  rule: NormalizedRule | undefined
  action: RuleAction | undefined
  text: string
  surface: Surface
  ctx: EngineContext & { now: number }
  loss: number
}

/** 一条命中记录（宿主据此写 session 事件）。 */
export interface EngineRecord {
  at: number
  ruleId: string
  kind: ActionKind
  placement: string
  outcome: string | undefined
  detail: string | undefined
  loss: number
  changed: boolean
}

/** run 的上下文。previous 是最近一次同接口请求的文本；surfaces 是已出现过的指纹。 */
export interface EngineContext extends MatchContext {
  previous?: string | null
  surfaces?: readonly string[]
}

/** createEngine 的选项。 */
export interface EngineOptions {
  /** 静态配置的规则。非法直接抛错。 */
  rules?: unknown
  /** 宏替换。 */
  macros?: Macros
  /** 正则缓存。 */
  provider?: RegexProvider
  /** 每条命中记录的回调（写 session 事件用）。 */
  onRecord?: (record: EngineRecord) => void
  /** 取当前时间；测试用。 */
  now?: () => number
}

/** registerConsumer 的入参。 */
export interface ConsumerInput {
  /** 消费者名（对应规则的 action.by）。 */
  name?: string
  /** 消费哪种动作。 */
  kinds?: readonly ActionKind[]
  /** 收到动作时的处理函数。 */
  handle?: (payload: DeliveryPayload) => void
}

/** run 的入参。surface 缺失会在运行时显式失败，不是可选项。 */
export interface RunInput {
  surface?: MatchSurface
  ctx?: EngineContext
}

/** run 的结果。 */
export interface RunOutput {
  text: string
  hits: Hit[]
  records: EngineRecord[]
  delivered: string[]
}

/** 一个已登记的消费者。 */
interface RegisteredConsumer {
  kinds: ActionKind[]
  handle: (payload: DeliveryPayload) => void
}

/** 交付方案：有人接就给目标列表，没人接就是一条失效原因。 */
type DeliveryPlan =
  | { ok: false; outcome: string; detail: string; targets?: undefined }
  | { ok: true; targets: [string, RegisteredConsumer][]; outcome?: undefined; detail?: undefined }

/** 引擎对象。 */
export interface Engine {
  rules(): NormalizedRule[]
  provideRules(name: string, produce: () => unknown): () => void
  registerConsumer(input?: ConsumerInput): () => void
  run(input?: RunInput): RunOutput
  fingerprintOf(ruleId: string, text: string): string
  consumers(): string[]
  sources(): string[]
}

/**
 * 建一个引擎。
 *
 * 这一层管四件事，它们都需要状态：
 *   1. 规则来源 —— 静态配置 + 运行时由别的插件提供
 *   2. 消费者注册 —— 谁消费哪种动作，按 action.by 找
 *   3. 冷却与 surface 去重 —— 时间上的「多久没跑过」，和上下文里的「有没有过」，这是两回事
 *   4. 命中日志 —— 哪条规则、什么位置、代价多少、结果如何
 *
 * 「变换必须留下记录」：每条记录都交给 onRecord 回调，由宿主写成一条 agent 看不到的
 * session 事件。库本身不依赖 DSH，所以这里只给回调，不碰会话。
 */
export function createEngine({ rules, macros, provider, onRecord, now }: EngineOptions = {}): Engine {
  if (now !== undefined && typeof now !== 'function') {
    throw new TypeError('dsh-rule-engine: now must be a function returning milliseconds')
  }
  if (onRecord !== undefined && typeof onRecord !== 'function') {
    throw new TypeError('dsh-rule-engine: onRecord must be a function')
  }
  const clock = now ?? ((): number => Date.now())
  const installed = normalizeRules(rules)
  /** 运行时规则来源：名字 → 返回规则数组的函数。 */
  const sources = new Map<string, () => unknown>()
  /** 消费者：名字 → { kinds, handle }。 */
  const consumers = new Map<string, RegisteredConsumer>()
  /** 每条规则上次真正生效的时间。 */
  const lastRunAt = new Map<string, number>()
  /** oncePerSurface 的指纹。 */
  const seenSurfaces = new Set<string>()

  /**
   * 当前全部规则：静态配置 + 各来源现给的。
   * 来源给的规则每次都要重新校验 —— 来源是别的插件，写错的规则应该立刻抛错，
   * 而不是悄悄不生效（规则引擎的产物是要发出去的请求，静默失效最危险）。
   */
  function currentRules(): NormalizedRule[] {
    const extra: NormalizedRule[] = []
    for (const [name, produce] of sources) {
      const produced = produce()
      if (produced === undefined || produced === null) continue
      try {
        extra.push(...normalizeRules(produced))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error('dsh-rule-engine: rule source "' + name + '" produced invalid rules: ' + message, { cause: error })
      }
    }
    return sortRules([...installed, ...extra])
  }

  /**
   * 注册一个运行时规则来源。
   * @param name 来源名（用于报错）。
   * @param produce 取规则的函数。
   * @returns 取消注册。
   */
  function provideRules(name: string, produce: () => unknown): () => void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('dsh-rule-engine: rule source needs a name')
    }
    if (typeof produce !== 'function') {
      throw new Error('dsh-rule-engine: rule source "' + name + '" needs a function')
    }
    sources.set(name, produce)
    return () => sources.delete(name)
  }

  /**
   * 注册一个消费者。
   * 消费者启动时声明「我消费哪种动作」，引擎按 action.by 找；找不到就跳过而不报错
   * （这是设计文档里定下的：规则先写好、消费者后到，不该互相阻塞）。
   */
  function registerConsumer({ name, kinds, handle }: ConsumerInput = {}): () => void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('dsh-rule-engine: consumer needs a name')
    }
    if (!isUnknownArray(kinds) || kinds.length === 0) {
      throw new Error('dsh-rule-engine: consumer "' + name + '" needs kinds')
    }
    const accepted: ActionKind[] = []
    for (const kind of kinds) {
      if (!isActionKind(kind)) {
        throw new Error('dsh-rule-engine: consumer "' + name + '" has an unknown kind ' + JSON.stringify(kind))
      }
      accepted.push(kind)
    }
    if (typeof handle !== 'function') {
      throw new Error('dsh-rule-engine: consumer "' + name + '" needs a handle function')
    }
    consumers.set(name, { kinds: accepted, handle })
    return () => consumers.delete(name)
  }

  /**
   * surface 指纹：同一条规则 + 同一段文本 = 同一件事。
   * 用来表达「这条提醒在当前上下文里已经出现过了」。
   */
  function fingerprint(rule: { id: string }, surface: { text: string }): string {
    return rule.id + '\u0000' + surface.text
  }

  function rememberSurface(print: string): void {
    seenSurfaces.add(print)
    if (seenSurfaces.size > MAX_SURFACE_MEMORY) {
      // Set 保持插入顺序，队首就是最老的。
      const oldest = seenSurfaces.values().next()
      if (!oldest.done) seenSurfaces.delete(oldest.value)
    }
  }

  /**
   * 这条规则的动作有没有人接；有的话交给谁。
   *
   * 指名了 by 就只找它，没指名就找所有声明消费这种动作的。
   *
   * **没人接的规则不生效。** 篡改没有执行者时，请求该保持原样，
   * 只在记录里留下一条失效事件 —— 改完文本再记一笔「没人接」，
   * 等于告诉调用方「改好了」，那是行为与意图不符。
   */
  function planDelivery(rule: NormalizedRule): DeliveryPlan {
    const kind = rule.action.kind
    const by = rule.action.by
    if (by !== undefined) {
      const consumer = consumers.get(by)
      if (consumer === undefined) {
        return { ok: false, outcome: 'no-consumer', detail: '找不到名为 "' + by + '" 的消费者，' + kind + ' 没有生效' }
      }
      if (!consumer.kinds.includes(kind)) {
        return { ok: false, outcome: 'no-consumer', detail: '消费者 "' + by + '" 不接 ' + kind + ' 动作，它没有生效' }
      }
      return { ok: true, targets: [[by, consumer]] }
    }
    const targets = [...consumers].filter(([, consumer]) => consumer.kinds.includes(kind))
    if (targets.length === 0) {
      return { ok: false, outcome: 'no-consumer', detail: '没有消费者接 ' + kind + ' 动作，它没有生效' }
    }
    return { ok: true, targets }
  }

  /**
   * 跑一轮：把规则作用在一段文本上，把动作交给消费者，留下记录。
   */
  function run({ surface, ctx = {} }: RunInput = {}): RunOutput {
    if (typeof surface !== 'object' || surface === null) {
      throw new TypeError('dsh-rule-engine: run expects a surface object')
    }
    const current = surface
    const surfaces = ctx.surfaces
    if (surfaces !== undefined && surfaces !== null && !isUnknownArray(surfaces)) {
      throw new TypeError('dsh-rule-engine: ctx.surfaces must be an array of fingerprints')
    }
    const nowMs = clock()
    const scope: EngineContext & { now: number } = { ...ctx, now: ctx.now ?? nowMs }
    const previous = scope.previous ?? null
    const rules = currentRules()
    const byId = new Map(rules.map(rule => [rule.id, rule]))
    const records: EngineRecord[] = []
    const delivered = new Set<string>()
    /** 本轮每条命中规则的动作该交给谁；gate 里算好，交付时直接用。 */
    const plans = new Map<string, [string, RegisteredConsumer][]>()

    const gate = (rule: NormalizedRule): GateVerdict => {
      // 先去重、后冷却：同一段内容报「说过」比报「时间没到」更准确。
      // 两者都只是「不生效」的原因，但原因错了会让人查错方向。
      if (rule.oncePerSurface) {
        const print = fingerprint(rule, current)
        if (seenSurfaces.has(print) || (surfaces ?? []).includes(print)) {
          return { ok: false, outcome: 'duplicate', detail: '这个 surface 上已经出现过' }
        }
      }
      if (rule.cooldownMinutes > 0) {
        const since = lastRunAt.get(rule.id)
        if (since !== undefined && nowMs - since < rule.cooldownMinutes * 60000) {
          return {
            ok: false,
            outcome: 'cooldown',
            detail: '冷却中：距上次命中 ' + Math.round((nowMs - since) / 1000) + ' 秒，冷却 ' + rule.cooldownMinutes + ' 分钟',
          }
        }
      }
      // 有没有人接：没人接的规则不生效，只在记录里留一条失效事件。
      const delivery = planDelivery(rule)
      if (!delivery.ok) return { ok: false, outcome: delivery.outcome, detail: delivery.detail }
      plans.set(rule.id, delivery.targets)
      return { ok: true }
    }

    const { text, hits } = applyRules({ rules, surface: current, ctx: scope, previous, macros, provider, gate })

    for (const hit of hits) {
      const rule = byId.get(hit.ruleId)
      const record: EngineRecord = {
        at: nowMs,
        ruleId: hit.ruleId,
        kind: hit.kind,
        placement: hit.placement,
        outcome: hit.applied ? 'applied' : hit.outcome,
        detail: hit.detail,
        loss: hit.loss ?? 0,
        changed: hit.changed === true,
      }
      if (hit.applied) {
        lastRunAt.set(hit.ruleId, nowMs)
        if (rule !== undefined && rule.oncePerSurface) rememberSurface(fingerprint(rule, current))
      }
      records.push(record)
      if (!hit.applied) continue

      const targets = plans.get(hit.ruleId)
      if (targets === undefined) {
        // 走到了这里说明 gate 放行了却没算交付方案，是引擎自己的 bug，不能兜底。
        throw new Error('dsh-rule-engine: internal: applied rule "' + hit.ruleId + '" has no delivery plan')
      }
      for (const [name, consumer] of targets) {
        consumer.handle({
          ruleId: hit.ruleId,
          kind: hit.kind,
          rule,
          action: hit.action,
          text,
          surface: current,
          ctx: scope,
          loss: hit.loss ?? 0,
        })
        delivered.add(name)
      }
    }

    if (typeof onRecord === 'function') {
      for (const record of records) onRecord(record)
    }
    return { text, hits, records, delivered: [...delivered] }
  }

  return {
    /** 当前全部规则（静态 + 来源）。 */
    rules: currentRules,
    provideRules,
    registerConsumer,
    run,
    /**
     * surface 指纹的公开算法。
     * 调用方用它把「已经出现过的 surface」存下来，跨进程重启后再传回 ctx.surfaces。
     */
    fingerprintOf: (ruleId: string, text: string): string => fingerprint({ id: ruleId }, { text }),
    /** 只读视图，给面板用。 */
    consumers: (): string[] => [...consumers.keys()],
    sources: (): string[] => [...sources.keys()],
  }
}
