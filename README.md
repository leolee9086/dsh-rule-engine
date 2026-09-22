# dsh-rule-engine

DSH 专用的规则引擎：输入「规则集 + 一段上下文」，输出「该做什么」。

核心是纯函数，不依赖 DSH，也不依赖任何具体插件。规则命中后交给关心它的人：
context_care 负责「通知模型」和「篡改上下文」这两类效果，别的插件也可以听同一条规则去做别的事
—— 循环输出时，它给模型注入一句「你在重复」，另一个插件在界面上提醒用户。
`action.by` 指名交给谁；不写就按 kind 广播给所有订阅者。

为什么要有这一层、以及全部讨论记录，见 [2026-09-22-规则引擎设计.md](2026-09-22-规则引擎设计.md)。

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

位置一共五个：`user` / `assistant` / `reasoning` / `tool-call` / `tool-result`。

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
| `said` `produced` | 文本出现在用户输入 / 助手输出里。`/.../flags` 按正则，其它按子串 |

OR 靠写两条规则，不做通用表达式引擎。

`args` 的例子：`{ tool: 'read', args: { path: ['D:/dev/src', '.js'] } }` ——
path 里必须同时出现这两段。

`idle` 在「从来没调用过这个工具」时**不命中** —— 否则所有提醒类规则会在会话开头一起响。

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
| lib/placement.js | 作用位置与作用域常量 |
| lib/regex.js | 正则编译、替换、宏替换（搬运自酒馆） |
| lib/rules.js | 规则的校验与规范化 |
| lib/match.js | 触发条件匹配 |
| lib/budget.js | 前缀缓存的字节级估算与预算收缩 |
| lib/apply.js | 把规则作用在一段文本上（纯函数） |
| lib/engine.js | 规则来源、消费者注册、冷却与去重、命中日志 |
| lib/index.js | 汇总导出 |

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

## 还没做的

- 没有接入任何插件。接 fetch-router 要加两样：改 body + 规则来源运行时提供。
- 没有面板。fetch-router 那个右侧栏面板（逐请求行 + 顶部计数 + 暂停按钮）是现成先例。
- 规则来源的接口形状还没定死：现在是一个返回规则数组的函数，够用，但「来源怎么被卸载、
  怎么和预设绑定」还没想。
