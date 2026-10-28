import { isRecord } from './guard.js'
import { createEngine, type Engine } from './engine.js'

export interface NoticeContext { agentId: unknown; signal?: AbortSignal; [key: string]: unknown }
export interface NoticeValue {
  id: string; text: string; sourceSeqs?: number[]; oncePerSurface?: boolean; cooldownMinutes?: unknown
  [key: string]: unknown
}
export interface NoticeControls {
  enabled?(sourceId: string, ruleId: string): boolean
  epoch?(sourceId: string, ruleId: string): unknown
  sinceSeq?(sourceId: string, ruleId: string): number
}
export interface NoticeRegistrant { plugin?: string | null; registration?: string }
export interface NoticeDescriptor {
  sourceId: string; plugin: string | null; registration: string; executor: string
  rules: { id: string; title: string; description: string; actions: { id: string; defaultEnabled: boolean; available: boolean; requires: string[] }[] }[]
}
type Source = (context: NoticeContext) => unknown | Promise<unknown>
interface Entry { source: Source; descriptor: NoticeDescriptor }

function check(notice: unknown, name: string): asserts notice is NoticeValue {
  if (!isRecord(notice)) throw new Error(`context-care: 通知源 "${name}" 产出的不是对象`)
  if (typeof notice.id !== 'string' || !notice.id.length) throw new Error(`context-care: 通知源 "${name}" 产出的通知没有 id`)
  if (typeof notice.text !== 'string' || !notice.text.length) throw new Error(`context-care: 通知源 "${name}" 产出的通知 "${notice.id}" 没有 text`)
  if (notice.sourceSeqs !== undefined && (!Array.isArray(notice.sourceSeqs) || !notice.sourceSeqs.length
    || notice.sourceSeqs.some((seq: unknown) => typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0))) {
    throw new Error(`context-care: 通知源 "${name}" 的 sourceSeqs 必须是非空事件序号数组`)
  }
}

/** 拉取来源、控制世代、证据时效与交付去重共用同一状态；Host 只负责注册和原生消息。 */
export function createNoticeChannel({ now = () => Date.now(), warn = (message: string) => console.warn(message), engine = createEngine({ now }) }: {
  now?: () => number; warn?: (message: string) => void; engine?: Engine
} = {}) {
  const sources = new Map<string, Entry>()
  function register(name: string, source: Source, registrant: NoticeRegistrant = {}) {
    if (typeof name !== 'string' || !name.length) throw new Error('context-care: 通知源要有名字')
    if (typeof source !== 'function') throw new Error(`context-care: 通知源 "${name}" 要是一个函数`)
    if (sources.has(name)) throw new Error(`context-care: duplicate notice source ${name}`)
    const entry: Entry = { source, descriptor: { sourceId: `contextNotices:${name}`, plugin: registrant.plugin ?? null,
      registration: registrant.registration ?? name, executor: 'dsh-context-care',
      rules: [{ id: 'notify', title: name, description: 'control_notice_evidence', actions: [{ id: 'notice', defaultEnabled: true, available: true, requires: [] }] }] } }
    sources.set(name, entry)
    return () => { if (sources.get(name) === entry) sources.delete(name) }
  }
  async function collect(context: NoticeContext, { enabled = () => true, epoch = () => 'initial', sinceSeq = () => -1 }: NoticeControls = {}) {
    const key = String(context.agentId)
    const proposals: { notice: NoticeValue; name: string; entry: Entry; sourceId: string; capturedEpoch: unknown; stamp: string }[] = []
    for (const [name, entry] of sources) {
      if (!enabled(entry.descriptor.sourceId, 'notify')) continue
      const sourceId = entry.descriptor.sourceId, capturedEpoch = epoch(sourceId, 'notify'), boundary = sinceSeq(sourceId, 'notify')
      let produced: unknown
      try { produced = await entry.source({ ...context, agentId: key, controlEpoch: capturedEpoch, sinceSeq: boundary }) }
      catch (error) { warn(`context-care: 通知源 "${name}" 出错: ${error instanceof Error ? error.message : String(error)}`); continue }
      if (context.signal?.aborted) context.signal.throwIfAborted()
      if (sources.get(name) !== entry || !enabled(sourceId, 'notify') || epoch(sourceId, 'notify') !== capturedEpoch) continue
      if (produced === undefined || produced === null) continue
      if (!Array.isArray(produced)) { warn(`context-care: 通知源 "${name}" 返回的不是数组`); continue }
      for (const notice of produced) {
        check(notice, name)
        // 重新启用后必须由原始事件位置证明新鲜，不能给旧队列盖上当前序号。
        if (boundary >= 0 && notice.sourceSeqs === undefined) { warn(`context-care: 通知源 "${name}" 缺少 sourceSeqs，切换后的通知已阻止`); continue }
        if (notice.sourceSeqs !== undefined && !notice.sourceSeqs.every(seq => seq > boundary)) continue
        proposals.push({ notice, name, entry, sourceId, capturedEpoch, stamp: JSON.stringify([key, name, notice.id]) })
      }
    }
    const out: (NoticeValue & { source: string })[] = []
    // 后续来源可能 await；提交前重验所有提案，过期提案不能消耗去重或冷却。
    for (const { notice, name, entry, sourceId, capturedEpoch, stamp } of proposals) {
      if (sources.get(name) !== entry || !enabled(sourceId, 'notify') || epoch(sourceId, 'notify') !== capturedEpoch) continue
      // 通知 ID 是原有的去重面；正文变化不能把同一候选伪装为新的 surface。
      const transaction = engine.prepare({ key: `notice-channel:${stamp}`, surface: { placement: 'user', text: notice.id }, ctx: { now: now() },
        rules: [{ id: 'notify', order: 0, oncePerSurface: notice.oncePerSurface !== false, cooldownMinutes: Number(notice.cooldownMinutes ?? 0),
          action: { kind: 'notify', say: notice.text } }],
        consumers: [{ name: 'notice-channel', kinds: ['notify'], handle() {} }],
        current: () => sources.get(name) === entry && enabled(sourceId, 'notify') && epoch(sourceId, 'notify') === capturedEpoch })
      if (!transaction.payloads.length) continue
      transaction.commit(); out.push({ ...notice, source: name })
    }
    return out
  }
  return { register, collect, catalog: () => [...sources.values()].map(entry => entry.descriptor) }
}
