import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoundedMatcher, createDetectorRegistry, normalizeRuleV2 } from '../lib/index.js'

// 宿主通路的契约：回调是本进程里的真实函数，不序列化、不转源码，所以能用闭包；
// 代价是没有 Worker 的超时与隔离，注册时只收同步函数。两条通路共用同一套生命周期、
// JSON 校验与独占组取舍，这个文件把差异和共同点逐条钉住。

const block = text => ({ id: 'b', view: 'original', role: 'assistant', type: 'text', text })
const stage = 'output.delta'
const options = { sessionId: 's', scope: 's/request/attempt', epoch: 'p' }
const input = (rules, text = 'MARK') => ({ stage, rules, blocks: [block(text)] })

/** 一条检测器规则；sourceId 用来区分身份大小。 */
const detectorRule = (sourceId, id, ref, extra = {}) => normalizeRuleV2({ schemaVersion: 2, sourceId, id, revision: 1, on: [stage],
  select: { view: 'original', roles: ['assistant'], blockTypes: ['text'] },
  match: { kind: 'detector', ref, revision: 1, params: {} },
  actions: [{ id: 'notify', kind: 'notify', stage, enabledDefault: true, template: 'hit' }], ...extra })

/** 注册声明的公共部分；stateSchema 空对象表示不限制状态形状。 */
const declaration = (ref, callbacks, path = 'host') => ({ plugin: 'host-test', ref, revision: 1, on: [stage],
  paramsSchema: { type: 'object', additionalProperties: false }, stateSchema: {}, resultSchema: {},
  ...(path === 'host' ? { hostCallbacks: callbacks } : { workerCallbacks: callbacks }) })

/** 只返回 ok 的最小回调集；overrides 用来替换其中一个回调。 */
const callbacks = (overrides = {}) => ({
  initialize: () => null,
  feed: ({ delta }) => ({ state: null, result: { ok: delta.includes('MARK'), ranges: [], captures: {} } }),
  finalize: ({ state }) => ({ state, result: { ok: false, ranges: [], captures: {} } }),
  reset: () => null,
  ...overrides,
})

const session = async (body) => {
  const matcher = createBoundedMatcher(), registry = createDetectorRegistry(matcher)
  try { return await body(registry) } finally { try { await registry.close() } finally { await matcher.close() } }
}

test('宿主检测器：真实函数在本进程直接调用，闭包可用', async () => {
  // 闭包是宿主通路存在的理由：函数根本没离开过这个进程。
  let seen = 0
  const feed = ({ state, delta }) => { seen++; return { state, result: { ok: delta.includes('MARK'), ranges: [], captures: {} } } }
  await session(async registry => {
    registry.register(declaration('test:host', callbacks({ feed })))
    const found = await registry.detect(input([detectorRule('host-test', 'marker', 'test:host')]), undefined, options)
    assert.equal(found.length, 1)
    assert.equal(found[0].sourceId, 'host-test')
    assert.ok(seen > 0, '闭包里的计数器被真实调用过')
  })
})

test('宿主检测器：增量状态在同一个流里保留，收尾后清掉', async () => {
  const resetReasons = []
  const specification = declaration('test:host', callbacks({
    initialize: () => ({ text: '' }),
    feed: ({ state }) => ({ state, result: { ok: false, ranges: [], captures: {} } }),
    reset: ({ reason }) => { resetReasons.push(reason); return { text: '' } },
  }))
  await session(async registry => {
    registry.register(specification)
    const rule = detectorRule('host-test', 'letters', 'test:host')
    assert.equal((await registry.detect(input([rule], 'a'), undefined, options)).length, 0)
    // 第二次喂入从上次的偏移继续，状态由宿主自己保管。
    assert.equal((await registry.detect(input([rule], 'ab'), undefined, options)).length, 0)
    await registry.release(options.scope)
    assert.deepEqual(resetReasons, ['stream-closed'])
  })
})

test('宿主检测器：注册时拒绝异步回调', async () => {
  await session(async registry => {
    assert.throws(() => registry.register(declaration('test:host', callbacks({ feed: async () => ({ state: null, result: { ok: true, ranges: [], captures: {} } }) }))),
      /detector-host-callback-must-be-synchronous:feed/)
  })
})

test('检测器注册必须明确选一条通路，两条都给也不行', async () => {
  await session(async registry => {
    const bare = { ...declaration('test:host', callbacks()) }
    delete bare.hostCallbacks
    assert.throws(() => registry.register(bare), /detector-callbacks-path-required/)
    assert.throws(() => registry.register({ ...declaration('test:host', callbacks()),
      workerCallbacks: { initialize: '() => null', feed: '() => null', finalize: '() => null', reset: '() => null' } }),
    /detector-callbacks-path-required/)
  })
})

test('宿主检测器：返回值同样要过 JSON 校验', async () => {
  await session(async registry => {
    // Map 不是普通 JSON：两条通路的契约一致，宿主不能因为‘反正没跨进程’就放过。
    registry.register(declaration('test:host', callbacks({ initialize: () => new Map() })))
    await assert.rejects(registry.detect(input([detectorRule('host-test', 'marker', 'test:host')]), undefined, options), /detector-value-must-be-plain-json/)
  })
})

test('宿主与 Worker 混用：独占组归全局排序更靠前的规则', async () => {
  const both = rules => [detectorRule('host-test', 'theirs', 'test:host', rules.host), detectorRule('worker-test', 'ours', 'test:worker', rules.worker)]
  // Worker 通路的回调只能是源码字符串：它要在另一侧重新编译。
  const workerCallbacks = {
    initialize: '() => null',
    feed: '({ delta }) => ({ state: null, result: { ok: delta.includes("MARK"), ranges: [], captures: {} } })',
    finalize: '({ state }) => ({ state, result: { ok: false, ranges: [], captures: {} } })',
    reset: '() => null',
  }
  const register = registry => {
    registry.register(declaration('test:host', callbacks()))
    registry.register(declaration('test:worker', workerCallbacks, 'worker'))
  }
  // Worker 规则优先级更高：宿主先跑并占住了组，但仲裁仍要把结果判给它。
  await session(async registry => {
    register(registry)
    const found = await registry.detect(input(both({ host: { priority: 10, exclusiveGroup: 'remind' },
      worker: { priority: 20, exclusiveGroup: 'remind' } })), undefined, options)
    assert.deepEqual(found.map(event => event.sourceId), ['worker-test'])
  })
  // 宿主规则优先级更高：Worker 侧应直接跳过同组里排在后面的规则。
  await session(async registry => {
    register(registry)
    const found = await registry.detect(input(both({ host: { priority: 20, exclusiveGroup: 'remind' },
      worker: { priority: 10, exclusiveGroup: 'remind' } })), undefined, options)
    assert.deepEqual(found.map(event => event.sourceId), ['host-test'])
  })
})

test('只挂宿主检测器时不进 Worker', async () => {
  const matcher = { detect: async () => { throw new Error('worker-must-not-run') } }
  const registry = createDetectorRegistry(matcher)
  try {
    registry.register(declaration('test:host', callbacks()))
    const found = await registry.detect(input([detectorRule('host-test', 'marker', 'test:host')]), undefined, options)
    assert.equal(found.length, 1)
  } finally { await registry.close() }
})

test('非检测器规则不会因为旁边挂了宿主检测器就搬到主线程', async () => {
  // 正则不受控，必须在 Worker 里跑；这条分流不能被宿主通路破坏。
  const calls = []
  const matcher = { detect: async payload => { calls.push(payload); return { events: [], states: {} } } }
  const registry = createDetectorRegistry(matcher)
  try {
    registry.register(declaration('test:host', callbacks({ feed: ({ state }) => ({ state, result: { ok: false, ranges: [], captures: {} } }) })))
    const plain = normalizeRuleV2({ schemaVersion: 2, sourceId: 'host-test', id: 'plain', revision: 1, on: [stage],
      select: { view: 'original', roles: ['assistant'], blockTypes: ['text'] }, match: { kind: 'always' },
      actions: [{ id: 'notify', kind: 'notify', stage, enabledDefault: true, template: 'hit' }] })
    const found = await registry.detect(input([detectorRule('host-test', 'marker', 'test:host'), plain]), undefined, options)
    assert.deepEqual(found, [])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].rules.map(rule => rule.id), ['plain'])
    assert.deepEqual(calls[0].blockedGroups, [], '没有人认领独占组时不传任何阻塞项')
  } finally { await registry.close() }
})

test('注册目录不暴露任何回调实现', async () => {
  await session(async registry => {
    registry.register(declaration('test:host', callbacks()))
    const entry = registry.catalog().find(spec => spec.ref === 'test:host')
    assert.ok(entry, '目录里应有刚注册的检测器')
    assert.equal('hostCallbacks' in entry, false)
    assert.equal('workerCallbacks' in entry, false)
  })
})
