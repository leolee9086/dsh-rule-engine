# 接入 context_care 与 better-query：规则引擎的第一个用例

- 时间：2026-09-22
- 场合：哥哥说「接 context_care 和 better_query 吧」，先做提醒通路
- 相关：`D:\dev\dsh-rule-engine\`、`D:\dev\dsh-context-care\`、`D:\dev\SAC_search\dsh-better-session-query\`

## 数据流

```
better-query                 context_care                     模型
   │                              │
   │ ctx.provide(                 │
   │   'memoryNoticeRules',       │
   │   纯数据规则数组)             │
   │                              │
   │                        ctx.get('memoryNoticeRules')
   │                              │
   │                        接进 rule-engine（每个会话一个实例）
   │                              │
   │                        agent/pre-step 时跑一轮
   │                              │
   │                        命中 notify → 注入一条 notice 消息 ──→ 模型
```

索引插件不知道谁在读它的规则；context_care 不知道规则是谁写的。
两边只认服务名和纯数据形状。

## 各插件改了什么

**dsh-rule-engine**
- `when.tool` 支持数组：数组表示「其中任意一个」，不是「同时调用」
- gate 里先去重、后冷却：同一段内容报「说过」比报「时间没到」准确

**dsh-better-session-query**（`lib/notice-rules.js` 新文件）
- `NOTICE_RULES` 纯数据：第一条是「记住」规则
- `ctx.provide('memoryNoticeRules', NOTICE_RULES)`
- 不 import 规则引擎，也不 import 任何插件 —— 零外部依赖

**dsh-context-care**（`src/notice-rules.js` 新文件）
- `installNoticeRules(ctx, { plugin })`：每个会话一个引擎实例
  （冷却和 surface 去重都是按会话算的）
- 注册消费者 `context-care`，只接 `notify`
- 规则来源走 `engine.provideRules`，每次 run 现取 `ctx.get('memoryNoticeRules')` ——
  取不到就是没装索引插件，不是错误
- `agent/pre-step` 里跑一轮，命中就 push 一条 notice 到这一轮的消息里
- 依赖 `@leolee9086/dsh-rule-engine`（版本号，不是 link:）

## 已知限制

- **只判用户刚说了什么**（`placement: user`）。`when.produced` 要看助手输出、
  `when.idle` 要看工具调用历史，两者现在都拿不到，声明了也不会命中。
  接上会话事件之后补。
- **`say` 里的模板没渲染**（`{args.path}` / `{tool}` / `{time}`）。现在直接注入原文。
- **transform 通路没做**。篡改要经过请求层，由提供 `requestRewrite` 服务的插件执行；
  现在没有这个服务，所以篡改类动作一律不生效 —— 这是对的行为，
  引擎在 gate 阶段就判「没人接」并留下失效记录。

## 待办

1. **规则引擎要发布到 npm**，两个插件才能正规依赖它（现在本地靠 node_modules 里的 junction 跑）。
2. **DSH 里跑的是 profile 里的副本**，改完要重装/重启才生效。
3. 模板渲染、toolCalls、transform 通路。

## 怎么让改动生效（不用等 npm 传播）

profile 里所有插件都是 `link:` 到本地 checkout（见 `C:\Users\al765\.dsh\profiles\web\package.json`）：

```json
"dsh-context-care": "link:D:/dev/dsh-context-care",
"dsh-better-session-query": "link:D:/dev/SAC_search/dsh-better-session-query"
```

所以 DSH 跑的就是 `D:\dev` 下的代码，**改完重启即生效**。
规则引擎本地走 `dsh-context-care\node_modules\@leolee9086\dsh-rule-engine` 这个 junction，
也不经过 registry。npm 上的 0.1.0 是给别的机器用的。

## 怎么验证「记住」规则

规则匹配的是**真人说的话**（`placement: ['user']` + `source.kind === 'user'`），
所以只有人说话才触发 —— 我自己发的不算。重启之后由哥哥说一句带「记住」的话来验。
