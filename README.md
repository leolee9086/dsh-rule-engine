# dsh-rule-engine

DSH 专用的规则引擎：输入「规则集 + 一段上下文」，输出「该做什么」。

引擎拥有规则规范化、条件与计数、块选择、模板、请求与显示规划、动作调度、Worker 生命周期、输出短语检测与反馈触发/回执结算、文档与变量存储策略、控制与冷却，以及事件投递、窗口、sticky 和共享配额算法。它不依赖 Cordis 或 DSH 包；Session 读取、存储实际 I/O、工具审批、原生取消与消息注入通过显式端口提供。库可以持有状态、调度线程和调用这些端口。

`createEngine` 的同一个来源注册表支持同步文本 `run`、块 `detect`、请求 `plan`、显示 `display` 和事件 `events`。`provideRules(name, produce)` 的来源函数可以按 `RuleQuery.sessionId`、`presetId` 与当前文档切面贡献规则；释放函数只移除自己拥有的贡献。事件来源注册与替换同样进入此注册表，卸载或 runtime 关闭后移除。Host 为当前操作传入已准入的规则切面时，`plan` / `display` 使用该切面，避免混入其它会话。

原有 v1 同步行为保留：按 scope、order 和词法 ID 排序；逐条变换读取前一条结果，保留宏、捕获替换、trim、编辑与深度条件、增量缓存损失预算、冷却、surface 去重和消费者错误语义。`action.by` 指定消费者，省略时按动作 kind 广播。需要无状态调用时，仍可直接使用 `applyRules`、`detectRulesV2`、`planRequest` 与 `planDisplay`。

为什么要有这一层、以及全部讨论记录，见 [2026-09-22-规则引擎设计.md](2026-09-22-规则引擎设计.md)。

## 0.9.0

检测器的回调拆成两条互斥的通路。`hostCallbacks` 交真实函数，在主进程直接调用，不序列化、可以带闭包，代价是没有 Worker 的隔离与超时；`workerCallbacks` 交源码字符串，在 Worker 的 vm 里重新编译执行，有隔离和超时。两条通路共用同一套 `initialize` / `feed` / `finalize` / `reset` 生命周期，以及 params、state、result 的 JSON 与 schema 校验，只差回调从哪里来。注册时二选一：两条都给、两条都不给都直接失败。

非检测器规则（含不受控正则）始终进 Worker，不会因为旁边挂了宿主检测器就搬到主线程。两条通路各自排序、各自执行，独占组由同一份全局顺序决出唯一的赢家；落败一方的事件丢弃。

规则可以自带内联判定器（`judge.code`）：一段函数表达式源码，引擎编译后执行，同步异步都行，能力只从 ctx 取。

```sh
pnpm add @leolee9086/dsh-rule-engine@0.9.0
```

## 0.8.0

规则声明由同一个编译入口接入同步文本、块/请求/显示计划与事件交付。字段校验统一使用 Zod 组合 schema，条件叶、布尔语法、阶段动作和接收范围共享定义及错误路径；阶段就绪类型从共同产物派生，`normalizeEventRule` 是阶段入口的别名。原有 provider/model/tool/args/idle/数值/文本事实编译为公共条件节点，`when.condition` 可以使用同一条件树。`Engine.prepare` 返回同步提案，`commit` 在环境 ACK 后确认冷却与 surface 去重；控制、来源或引用能力变更会使旧提案失效。

`transform` 动作在请求/显示副本上顺序执行：后一条读取前一条输出，保留查找宏三种模式、替换宏、捕获/具名捕获、trim、深度和编辑条件。原坐标 `replace`/`filter`/`inject` 先完成基线裁决，顺序变换再读取裁决结果；一次性与增量补丁共用 `createBlockPatchPlan` 的优先级决议和阻塞恢复，正则程序与补丁物化共用 UTF-16 编辑内核；依赖不能倒读后续执行阶段。同步 API 返回原同步结果，Host 可以用 `planRequestAsync` / `planDisplayAsync` 把相同文本计划交给可终止 Worker。

外部包通过 `engine.extensions.registerCondition` / `registerAction` 注册带 `ref`、`revision` 和 `paramsSchema` 的编译能力。声明使用 `{ kind: 'extension', ref, revision, params }`，在交给 Worker 前展开为共同条件/动作，复用已有选择、控制、预算、依赖和 ACK。每个动作扩展产出一个动作，调用方保留动作 ID、阶段与依赖身份；运行期副作用通过执行器端口接入。注册函数返回所属贡献的释放函数，版本替换或卸载使引用它的提案与候选失效，无关扩展保持已有候选。

```sh
pnpm add @leolee9086/dsh-rule-engine@0.8.0
```

## 0.6.0

补齐提醒领域职责：通知来源注册、控制时效与去重/冷却、同步通知收集及命中证据、完成措辞解析与原生事实投影、完成提醒的候选/预约/交付、静态与模型切换提示的精确路由、循环裁剪与提醒处置、流式提醒额度，以及请求改写 ACK 后的事务记账均由库实现。

`createNoticeChannel`、`createNoticeRuleRuntime`、`createCompletionFeedback`、`createStreamNoticeActions` 和 `createRequestRewriter` 通过显式端口接入环境。完成事实文本用可迭代块提供，在库内检查长度预算后才拼接；缓存仍由 Host 的共享端口拥有。旧独立调用方的完成观察与出站状态转换也由库提供，生产路径不打开它们的旧侧表。插件继续提供原生 Session 事件解释、切面和 lease、存储 I/O、工具/服务注册、消息创建/注入/取消以及提示文案。

```sh
pnpm add @leolee9086/dsh-rule-engine@0.6.0
```

## 0.5.1

修复并行冷检测时重复编译 Ajv 元 schema 耗尽匹配预算的问题。每个 Worker 在 ready 前准备一次编译器；用户 schema 编译和检测仍使用原工作预算，回调仍受原 VM 超时限制。每次编译后清理用户定义，保留独立 `$id` / `$ref`、本地递归、元 schema 别名、严格验证及原 16 项 LRU；不复用检测器回调全局状态。

```sh
pnpm add @leolee9086/dsh-rule-engine@0.5.1
```

## 0.5.0

统一规则引擎版本。请求/显示规划、事件运行时、Worker、存储策略、输出反馈及交付恢复均在库内，通过显式环境端口接入。消费方使用标准依赖安装，无需本地源码路径、模块解析钩子或 TypeScript 路径覆盖；原有 v1 同步能力保留。

```sh
pnpm add @leolee9086/dsh-rule-engine@0.5.0
```

## 原生 v2 匹配

`normalizeRuleV2` 校验多动作规则，`detectRulesV2` 返回一次命中的捕获、UTF-16 半开区间及原始块引用。`select.depth` 先按消息、轮次或块计数，再筛选角色与块类型；正文、思考、工具调用与结果可独立选择。模板与执行调度在库内实现，实际环境操作由类型化端口执行。`createRuleStore` 在保存 ACK 后发布文档、变量与 runtime 新状态；失败保留旧状态和原始错误。

输出消费方可传 `freshSeq`，同时提供截至该序号的完整历史窗口。跨块正则和关键词优先选择触及当前输出的匹配；只命中历史内容的规则不会认领独占组。返回的 `triggerSeq` 表示实际触发输出，`sourceSeqs` 保留整个检查窗口，不能用窗口里恰好包含新消息来代替触发证据。未传 `freshSeq` 的请求装配匹配保持按窗口选择的行为。`createBoundedMatcher` 与统一 `runRuleWorker` 在库内运行可终止 Worker，限制正则回溯和判定器耗时；Host 仅提供环境任务与回执。

包入口公开 `V2_STAGES`、`V2_ACTIONS`、`readBinding`、`bindInputs`、`normalizeRuleV2`、`selectBlocksV2`、`matchConditionV2`、`detectRulesV2`、`validateDetectorEvidenceV2` 与 `applyBlockPatchesV2`，保留已有 v1 导出。根正则条件的 `all: true` 返回各次命中的独立捕获与范围（最多 1000 次），零宽匹配按 Unicode 码点前进。外部 detector 的结果通过统一证据校验后参与原生优先级与互斥选择；库的 detector 注册表负责注册、版本、线程、取消和状态；外部 detector 与内建 detector 都经相同证据校验后参与匹配。

`replace` 的区间针对不可变基线，重叠写入按优先级决议；同一规则计划也支持 `transform` 顺序文本动作。基线补丁保持原坐标，顺序动作读取补丁裁决后的文本，供需要 `foo→bar→baz` 连续变换的规则使用。`applyRules` 的同步顺序合同保留。

## 统一声明与事件交付

`events.connectDocuments(ports)` 接收原生文档文本、根 ID、来源 key、读取/订阅/接收资格端口。引擎拥有 `dsh-rule` YAML/JSON 围栏解码、共同声明校验、来源快照、增量失效、容量重试和撤回；适配插件只处理应用自己的块结构、SQL、推送、凭据和 I/O。输入统一使用 `schemaVersion: 2`，不保留插件格式转换。来源注册只生成一次规范化产物，事件调度和同一 Engine 的同步/块/规划视图复用它；查询不会重新编译扩展。

同步字段、动作、事实和阶段声明的公共类型以及默认值均由对应 schema 推导。`createBlockPatchPlan` 是唯一增量补丁工厂，批处理也使用同一决议算法。

事件规则使用同一个 `schemaVersion: 2` 声明与 `normalizeRule`，正文条件使用统一 `match` 树。`event` 描述工具名、原生事件名、输出模式、时间窗口与真人在场条件；`recipient` 描述接收会话范围。通知动作通过 `delivery.model` 指定 surface/window 去重、sticky、共享配额或显式中断，工具拒绝通过执行前动作的 `deny: { dangerous: true, reason }` 声明。

```js
const engine = createEngine()
const events = engine.events({
  execute: (work, signal, timing) => matcher.detect(work, signal, timing),
  templates: createTemplates(),
  resolveIdentity: sessionId => readCurrentSessionIdentity(sessionId),
  updateClaims: change => serializedNativeClaimsUpdate(change),
})
const source = events.registerSource({
  sourceId: 'example', plugin: 'example-plugin', revision: 1,
  rules: [{ schemaVersion: 2, sourceId: 'example', id: 'read-check', revision: 1,
    on: ['tool.succeeded'],
    select: { view: 'original', roles: ['tool'], blockTypes: ['tool-result'] },
    match: { kind: 'always' }, event: { tool: 'read' },
    actions: [{ id: 'model', kind: 'notify', stage: 'tool.succeeded', enabledDefault: true,
      template: '核对实际读取结果。', delivery: { model: { once: 'surface' } } }],
  }],
})
// 环境提交已观察到的事实，在自然请求边界收集并通过正常消息队列交付。
await events.submit({ sessionId: 'session-a', callId: 'read-1', rootCallId: 'read-1', name: 'read' })
const messages = await events.collect({ sessionId: 'session-a', visible: [] })
await source.dispose()
await events.close()
```

同一规则的条件与 judge 每轮只评估一次，各动作仍保留自己的身份、依赖、开关、候选、回滚、冷却和配额。动作 `cooldownMs` 从本次激活起计，时钟随真实 inbox 交接恢复，revision 参与动作时钟身份；sticky 的既有续投不被新激活冷却打断。只有声明冷却的事件动作额外读取时钟投影。独占组选择规则后允许该规则的全部适用动作；依赖动作按库内稳定拓扑顺序执行。`eligible` 端口提供实时控制，未提供时使用规则与动作的默认启用状态。

事件运行时只接受当前引擎声明，不执行 `reminder/v1` 至 `reminder/v4`。`recordedDelivery`、`applyDeliveryFact` 和 `recordDeliveryClaim` 仅读取原生已交付消息中的参数作为事实，保留实际消费、窗口与 sticky 计数；不会把历史声明改造成可执行规则。默认 `model` 的已发布配额与窗口键保持不变，其它动作使用自己的动作 ID。Session inbox 已接纳的消息保留原 ID、冻结正文、签名与控制代次；候选侧文件不是生产恢复依据。

交付事务同样由库编排：

- `createClaimRuntime` 通过原生日志/inbox 端口串行恢复跨会话配额账本，只释放已取消的预约；实际提交的消费不能被回滚撤销，失败变更不发布。
- `createDeliveryRuntime` 在 Host 的缓存端口内恢复交付时钟、queued 输入和带序号的 handoff 回执。完整恢复与轻量 queued 视图共用 `applyQueuedDeliveryFact`；原生切面、lease 和缓存代际仍由 Host 管理。
- `collectDeliveryInputs` 负责请求前评估、收集与原位替换冻结输入；`filterDeliveryMessages` 在每次回滚后重验，并可用同步 `commit` 端口把最终决定直接交给环境；`handoffQueuedDelivery` 在最后重验后同步调用发布端口。
- `SnoozeWindow`、`SnoozeResult`、`snoozeResultSchema` 与 `readSnoozeResult` 定义保留事实；工具注册、正文/元数据承载与本地化文字由环境提供。上下文截断共用 `requestContext`。

## 判定器：规则自带的代码

条件树只能写固定形状，判断不了「这段输出刷屏了没」这种要算的事。`judge` 就是给这种场合的：规则里直接写一段函数表达式，引擎编译成函数执行，返回 `{ ok }` 决定这一条命中不命中。

```yaml
judge:
  params: { probability: 0.3, maxPerSurface: 2, key: read-partial }
  code: |
    ({ event, params, state, random }) => {
      const key = `${params.key}|${event.triggerSeq}`
      const used = state.get(key) ?? 0
      if (used >= params.maxPerSurface) return { ok: false }
      if (random() >= params.probability) return { ok: false }
      state.set(key, used + 1)
      return { ok: true }
    }
  timeoutMs: 250
```

- `code` 必须是函数表达式；同步、异步都行（返回 Promise 会被 await）。
- **没有闭包**：源码独立编译，外部变量一律走 ctx。
- ctx 五个字段：`event`（事件事实）、`params`（规则里的 params）、`state`（`Map`）、`helpers`（`detectDegradation` / `describeHit`）、`random`。
- `state` 同一段源码共享一份，在 Worker 存活期间持续，回收即清零，不落盘；源码改一个字就重新编译、state 重来。
- 编译失败、返回形状不对、超时，都只让这一条规则在本次评估里报错，其它规则照常。
- 写法上注意：源码包在 `(` `)` 里执行，末尾带行注释也不影响外壳（引擎已换行包裹，有测试盖）。

与 `judge.ref` 的分工：`ref` 指向脚本安装时注册的具名判定器（跨插件共用）；`code` 随规则走，写规则的人在笔记里改完就生效。

## 检测器：两条回调通路

规则的条件树写不了「把这段流慢慢啃一遍」这种活儿，`match: { kind: 'detector' }` 就是给它的：插件注册一个检测器，规则只写引用、版本和参数。回调有四件套：`initialize` 起状态，`feed` 吃一段增量并给出证据，`finalize` 收尾，`reset` 交出干净状态。

回调放在哪执行，由注册时选哪条通路决定：

```js
// 宿主通路：真实函数，就在本进程跑。可以用闭包，但没有超时和隔离。
registry.register({
  plugin: 'my-plugin', ref: 'my:counter', revision: 1, on: ['output.delta'],
  paramsSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
  stateSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  resultSchema: {},
  hostCallbacks: {
    initialize: () => ({ text: '' }),
    feed: ({ state, params, delta }) => ({ state: { text: state.text + delta },
      result: { ok: state.text.includes(params.token), ranges: [], captures: {} } }),
    finalize: ({ state }) => ({ state, result: { ok: false, ranges: [], captures: {} } }),
    reset: () => ({ text: '' }),
  },
})

// Worker 通路：源码字符串，进 Worker 的 vm 重新编译。有隔离和超时，没有闭包。
registry.register({
  plugin: 'my-plugin', ref: 'my:counter-worker', revision: 1, on: ['output.delta'],
  paramsSchema: {}, stateSchema: {}, resultSchema: {},
  workerCallbacks: {
    initialize: '() => null',
    feed: '({ delta }) => ({ state: null, result: { ok: delta.includes("MARK"), ranges: [], captures: {} } })',
    finalize: '({ state }) => ({ state, result: { ok: false, ranges: [], captures: {} } })',
    reset: '() => null',
  },
})
```

两条通路的差别只有「回调在哪里跑」，契约完全一样：

- **二选一**：同一份注册只能给 `hostCallbacks` 或 `workerCallbacks`。两条都给、两条都不给都报 `detector-callbacks-path-required`。
- **宿主回调必须是同步函数**：异步回调没法在当前这一趟匹配里返回结果，注册时就会被拒绝。
- **返回值同样过 JSON 与 schema 校验**：宿主通路不因为「反正没跨进程」就放宽。`state` 超预算、`result` 形状不对，报的错与 Worker 通路一致。
- **宿主没有 Worker 的超时与隔离**：在 `feed` 里写死循环会把调用方卡住，注册者自己负责。反过来，需要防住不可信代码时用 `workerCallbacks`。

分流与取舍：

- 非检测器规则（含不受控正则）**始终进 Worker**，不会因为旁边挂了宿主检测器就搬到主线程。
- 只挂宿主检测器、规则里也没有别的东西时，根本不起 Worker。
- 两条通路各自排序、各自执行。同一个 `exclusiveGroup` 可能在两边都判出结果，最终由同一份全局顺序（scope → priority → sourceId → id）决出唯一的赢家，落败一方的事件丢弃。落败一方的回调已经执行过，它自己的状态记账不回滚——这是两条通路分开执行的代价，不影响本趟输出。

## 缓存与环境职责

Host 的共享 SessionCache 持有原生 Session、冷读取合并、替换代数和不可变切面。库的 `createRequestPlanCache`、`createDisplayPlanCache`、模型正文/工具配对投影、块/动作索引通过 `PlanningCachePort` 使用这份缓存，操作关闭时清除自己的域；库不再创建第二份 Session 缓存。请求字节比较保留完整 public JSON 的字段顺序，变量 CAS 也保留读取时的原始 JSON 字段顺序。请求写入拥有独立副本，历史切面不随新事件增长。

库不导入 DSH、不打开其 Session 文件，也不持有 Agent。环境负责把原生事件/流帧映射成库输入，把批准的工具、实际持久化和消息交付接到端口，HTTP 与 UI 留在消费插件。

## 用法

```js
import { createEngine, applyRules, selectWithinBudget } from '@leolee9086/dsh-rule-engine'

const engine = createEngine({
  rules: [{
    id: 'scrub-empty-reasoning',
    order: 10,                                   // 优先级，必填
    placement: ['reasoning'],                    // 只对思考内容生效
    when: { findRegex: '/^(Thinking\\.\\.\\.)+$/', replaceString: '' },
    action: { kind: 'transform' },
    budget: { maxCacheLoss: 0.1 },               // 最多废掉 10% 的缓存
  }],
  onRecord: record => writeSessionEvent(record), // 变换必须留下记录
})

engine.registerConsumer({
  name: 'fetch-router',
  kinds: ['transform'],
  handle: payload => rewriteBody(payload),
})

const result = engine.run({
  surface: { placement: 'reasoning', text: 'Thinking...' },
  ctx: { provider: 'deepseek', model: 'v4-flash', previous: lastRequestBody },
})

result.text     // 变换后的文本
result.records  // 这次跑完留下的记录
result.delivered // 实际收到动作的消费者
```

## 规则形状

```js
{
  id: 'scrub-empty-reasoning',   // 必填，重复会抛错
  order: 10,                     // 必填，优先级
  scope: 0,                      // 可选，作用域优先级：0 全局 / 1 会话 / 2 预设
  enabled: true,
  placement: ['reasoning'],      // 对哪些位置生效；空数组 = 哪都生效
  depth: { min: 1, max: 10 },    // 可选，只对最近 N 条生效
  markdownOnly: false,           // 只改显示
  promptOnly: false,             // 只改发出去的
  runOnEdit: false,              // 编辑历史消息时也跑
  when: { ... },                 // 触发条件
  action: { kind: 'transform' }, // notify 或 transform
  budget: { maxCacheLoss: 0.1 }, // transform 必填：这条规则最多废掉多少缓存（比例）
  cooldownMinutes: 30,           // 提醒类：多久之内不再重复
  oncePerSurface: true,          // 提醒类：同一个 surface 上只出现一次
}
```

位置一共六个：`user` / `assistant` / `reasoning` / `tool-call` / `tool-result` / `request`。
`request` 是组装好的整段请求体 —— 只有请求层看得见它，所以只有提供 `requestRewrite` 服务的插件用得上。

## 优先级必须显式写出来

优先级 = `scope` + `order`，两部分都写在规则里。

`order` 缺失会直接抛错。理由：规则可能来自静态配置，也可能来自运行时由别的插件提供，
合并之后「谁先声明」这件事根本不存在 —— 拿声明顺序当优先级是假的。
同 `scope` 同 `order` 的规则按 id 排，只为了让顺序确定；要控制先后就给不同的 `order`。

校验严格：任何一条规则不合法都直接抛错，调用方据此拒绝安装、保持原行为（fetch-router 的风格）。

## 说不清楚的输入直接失败，不做降级

这比「配置非法就拒绝安装」更进一步：**运行时遇到说不清楚的输入也抛错**。

- 正则编译不出来 → 抛错。不当成「没命中」—— 一条写坏的规则静默失效，比它当场报错危险得多。
- flag 非法 → 判为编译失败。酒馆在这里会退回「把整个输入当 pattern」，
  于是 `/a/z` 悄悄变成匹配 `a/z` 的正则；意图不清，宁可失败。
- `replaceString` 省略和空串是两回事：省略是「没说」，抛错；空串是「换成空」。
- `surface.text` 必须是字符串。没有文本的 surface（比如只有参数的工具调用）给空串，不能不给。
- `trimStrings` 里有空串 → 抛错。空串会匹配每一个位置，写它的人多半想写别的。
- 布尔字段给了就必须是布尔：`oncePerSurface: 'yes'` 不会悄悄变成 `false`。
- `gate` 返回 `undefined` 表示放行；返回别的东西是写错了。
- `byteLength` / `commonPrefixBytes` 这类度量函数也不吃 `undefined`。

代价是规则写起来更长：`id`、`order`、以及 transform 规则的 `budget.maxCacheLoss` 都是必填。
这三条一旦给错默认值，就会变成「规则看起来在生效、其实一直没跑」，比多写几个字段糟得多。

## 触发条件全是 AND

| 条件 | 含义 |
|---|---|
| `findRegex` | 完整正则，用 `/pattern/flags` 字符串写。global / sticky 都支持 |
| `replaceString` | 替换串，支持 `$1` / `$<name>` / `{{match}}` |
| `trimStrings` | 先匹配一大块，再去掉里面不要的串 |
| `substituteRegex` | 宏替换方式：0 不替换 / 1 先替换宏 / 2 先替换宏再转义 |
| `provider` `model` `purpose` | 请求维度，glob 匹配（只支持 `*`） |
| `tool` | 工具名，glob 匹配 |
| `args` | 工具参数，参数名到子串；数组表示「都要包含」 |
| `idle` | 一段时间没调用某个工具：`{ since: '工具名', minutes: 10 }` |
| `numbers` | 数值比较：`{ 指标名: { gte: 60 } }`。比较符 `gte` / `gt` / `lte` / `lt` / `eq`，多个指标是 AND |
| `said` `produced` | 文本出现在用户输入 / 助手输出里。`/.../flags` 按正则，其它按子串 |

OR 靠写两条规则，不做通用表达式引擎。

`args` 的例子：`{ tool: 'read', args: { path: ['D:/dev/src', '.js'] } }` ——
path 里必须同时出现这两段。

`idle` 在「从来没调用过这个工具」时**不命中** —— 否则所有提醒类规则会在会话开头一起响。

`numbers` 的指标名是**开放集合**：引擎只按 key 从 `ctx` 里取一个有限数再比，
**不认识任何指标名**。键叫什么、谁来填、什么范围算异常，全由提供值的插件定义
（例如 context_care 填疲劳度与唤醒值、token 量、轮数；以后加指标不必改引擎）。
两种「没有值」分得很开：
- 规则要的指标**根本不在 `ctx` 里** → 抛错。那是规则写错、或调用方漏填，属于配置问题；
  静默当成 false 的话规则会「看起来在生效、其实一直没跑」，比抛错糟得多。
- 键在、值是 **`null`** → **不命中**。那是提供方在说「此刻不可知」（例如模型信息拿不到时算不出疲劳度）。
  跟 `idle` 在「从没调用过这个工具」时返回 false 同构：「现在判不了」不该连累同一批里的其它规则，
  也不该硬凑一个默认值去比。

`ctx` 里的数值由调用方填，跟 `ctx.now` / `ctx.toolCalls` 一样是约定，不是引擎造出来的。

## 动作只有两种

- `notify`：提醒。context_care 收到后注入提示；别的插件也可以听同一条规则去做别的事
- `transform`：修正。context_care 收到后决定做不做，再由能碰请求层的插件去改发出去的请求

`action.by` 指名交给谁；不写就按 kind 广播给所有订阅者。同一条规则可以多方关心 ——
循环输出时 context_care 提醒模型，另一个插件提醒用户。

### 没人接的规则不生效

指名了但找不到，或者没指名而没人订阅这种动作 —— 这条规则**不执行**，
只在记录里留一条 `no-consumer` 的失效事件。

篡改尤其是这样：没有执行者的时候，请求必须保持原样。改完文本再记一笔「没人接」，
等于告诉调用方「改好了」，那是行为与意图不符。提醒类同理，没人接的提醒不会凭空出现。

还有一层在消费者那边：装了 context_care 但没装 fetch-router 时，它**收得到**篡改动作，
只是没有手去执行。这种情况下它自己也要产出一条**篡改失效事件** ——
提醒规则照常有效，篡改规则无效，但失效这件事必须看得见。

## 缓存预算是第一性的

规则给的是「最多损失多少缓存」，作用范围是算出来的。

- **字节级前缀估算**：跟最近一次**同接口**请求的文本比公共前缀。不建树、不做投影、不做字段策略 ——
  比较对象只有上一次，因为缓存也只跟上一次比。
  语义相同但字节不同就是真失效，不是误判。
- **单条规则的自我约束**：`budget.maxCacheLoss` 限制这条规则自己造成的增量损失，
  超了就跳过这条变换，记 `over-budget`。
- **请求级的总预算**：`selectWithinBudget` 从尾部往前贪心，改一处算一次代价，累计到上限就停。
  越靠后失效越小，尾部优先是最优解。

```js
const plan = selectWithinBudget({
  previous,                 // 最近一次同接口请求的文本；没有就传 null
  segments,                 // 本次请求的文本片段，按顺序，拼起来就是完整文本
  replacements: [           // 想改哪些片段
    { index: 0, text: '...' },
    { index: 3, text: '...', required: true },  // 不做就不能发
  ],
  maxCacheLoss: 0.2,
})
plan.text            // 最终文本
plan.accepted        // 被接受的片段下标
plan.rejected        // 因为超预算被拒的下标
plan.forced          // 无条件接受的下标
plan.exceedsBudget   // 必须做的那些本身就已经超预算 —— 调用方据此拒绝发送
```

`required: true` 是给隐私清洗这类「做了才能发」的变换用的：无条件接受，代价照算，
超预算时由调用方决定拒绝发送。而一般的超预算，做不做由人定（走批准）。

## 0.7.0 接入契约

`createEventRuntime(options)` 与 `engine.events(options)` 必须显式提供 `saveCapacity`、`changed`、`report` 和 `sinceSeq`。独立持久化模式还必须提供 `save`；`sessionAuthoritative: true` 由 Session 日志恢复，允许省略旧候选状态写入器。漏接端口在创建时抛出具体错误，不能以空 ACK、丢弃诊断或默认扫描边界继续运行。没有政策重置的独立环境须显式提供 `sinceSeq: () => -1`；测试环境自行提供内存写入器。

首次启动没有恢复记录时可以省略 `entries`；没有原生事件目录的独立环境可以省略 `catalog`。这两项表示合法的空输入。DSH 的原生适配器负责传入由发布 schema 自动生成的事件目录。

`EventFieldShape` 只定义在自动生成模块 `src/generated/event-field-shape.ts`，由 `pnpm generate:types` 生成并通过公共入口导出。引擎 selector 和原生目录生成器均使用这一个类型，环境目录只生成事件名与载荷，不再生成第二份类型。`pnpm build` 先检查生成产物是否过期；`pnpm check` 还以原严格 TS 配置核对必填端口的公开声明。

插件调用方直接从本库导入公共能力；原生适配器只暴露其实际封装的能力，不转发库 API。

## 引擎管的是生命周期

`createEngine` 那一层知道时间、知道谁在消费，所以它是有状态的壳：

- **规则来源两种**：`rules` 静态配置，`provideRules(name, fn)` 运行时由别的插件提供。
  来源给的规则每次 run 都重新校验，写错立刻抛错并指出是哪个来源。
- **消费者注册**：`registerConsumer({ name, kinds, handle })`，启动时声明「我消费哪种动作」。
- **冷却与 surface 去重是两回事**：`cooldownMinutes` 管时间上「多久没跑过」，
  `oncePerSurface` 管上下文里「有没有过」。指纹算法用 `engine.fingerprintOf(ruleId, text)` 取，
  存下来跨进程重启后再传回 `ctx.surfaces`。
- **命中日志**：每次命中记 `{ at, ruleId, kind, placement, outcome, detail, loss, changed }`，
  交给 `onRecord` 回调，由宿主写成一条 **agent 看不到的 session 事件**。

不变量是单向的：模型看到的必须能从日志重建，没规定记下来的必须被模型看到。

## 文件分工

| 文件 | 管什么 |
|---|---|
| src/placement.ts | 作用位置与作用域常量 |
| src/guard.ts | 类型收窄函数（unknown → 具体类型） |
| src/types.ts | 跨模块共享的数据形状 |
| src/regex.ts | 正则编译、替换、宏替换（搬运自酒馆） |
| src/rules.ts | 规则的校验与规范化 |
| src/match.ts | 触发条件匹配 |
| src/budget.ts | 前缀缓存的字节级估算与预算收缩 |
| src/apply.ts | 把规则作用在一段文本上（纯函数） |
| src/v2.ts | v2 规则、条件求值、块选择、补丁应用 |
| src/engine.ts | 规则来源、消费者注册、冷却与去重、命中日志 |
| src/index.ts | 汇总导出 |

## 从酒馆搬来的与改掉的

搬来的：`/pattern/flags` 字符串形式的正则、替换语法、`trimStrings`、宏替换、
`placement`、`minDepth/maxDepth`、`markdownOnly/promptOnly`、`runOnEdit`、
三层作用域、正则编译缓存（LRU，1000 条，取用时重置 lastIndex）。
酒馆的正则扩展是 AGPL-3.0，所以**整包按 AGPL-3.0-or-later 分发**（见 LICENSE）——
不是只有 `lib/regex.js` 一个文件受影响：衍生作品整体都受它约束。

改掉的：

- 宏替换由调用方注入函数，不 import 酒馆的全局脚本 —— 这样这一层不依赖 DSH。
- 替换回调里不做变量复用。酒馆复用了 `match` 变量，于是某个 `$1` 取到值之后，
  后面取不到的 `$<name>` 会返回 `$1` 的值。我们是从零开始的库，没有要兼容的存量规则，
  所以每个占位符独立解析、取不到就是空串。
- 优先级去掉「列表内顺序」这一层兜底，`order` 必填。
- 不做降级回退：酒馆在好几处把说不清楚的输入悄悄当成另一种意思，这里一律判为失败。

## 开发与发布

源码位于 `src/`，`pnpm build` 生成 `lib/` 中的 JavaScript、类型声明和 source map。包入口同时提供运行时 API 与 TypeScript 类型；构建产物不纳入版本控制。

```powershell
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 运行 TypeScript 构建、ESLint 和测试。`prepack` 执行同一检查链。发布必须使用已提交并与上游同步的 `main` 分支，保持工作树干净，不禁用 Git 检查。

```powershell
pnpm login --auth-type=web --registry=https://registry.npmjs.org/
pnpm publish --access public --registry=https://registry.npmjs.org/
```
