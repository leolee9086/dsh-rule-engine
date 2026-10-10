# 外部插件的事件写不进日志：append 不透出 ignorable

2026-09-23 晚。重启后这个会话加载失败：

```
history load failed: session contains event type "context-care/loop-clean" (seq 10828)
unknown to this harness and not marked ignorable; refusing to interpret the log
```

## 根因（已查证）

`Session.append`（`packages/core/session/src/index.ts:719`）造事件时**不写 `ignorable`**，
签名里也没有位置放它：

```ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
): SessionEvent<T> {
  const event = deepFreeze({ type, seq, time, data, ...surfaceMetadata })
  //                                        ↑ 没有 ignorable
}
```

而读路径是严格的：

- `packages/core/session/src/surface.ts:285`：未知类型 + `ignorable === true` 才跳过；
- `known-event-types.ts` 的头部注释：
  > Downstream (out-of-repo) plugin events are outside this list by construction.
  > The persisted `SessionEvent.ignorable` marker is the compatibility mechanism;
  > event-name registration was rejected because it does not classify omission safety
  > and would make reads composition-dependent.
- 设计笔记 `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`：
  字段是**为了一个依赖它的第三方插件**而保留的，并且明确“没有任何第一方生产者”。
  我 grep 了整个 packages：`ignorable: true` 确实只出现在测试、fixture、seed 里，没有生产端调用点。

所以：**字段、读路径、持久化、transport 都在，只有写路径缺失。**
外部插件落一条自定义事件，写的时候一切正常，**炸在下一次重启**。

## 我这边踩到的两处

context-care 一共 7 处 append，其中 5 处用的是 DSH 已知类型（`compaction/*`、`user/message`），没事：

| 位置 | 事件类型 | 状态 |
|---|---|---|
| `src/index.js:555` | `context-care/loop-clean` | 自定义，无 ignorable ✗ |
| `src/transform-log.js:69` | `context-care/transform` | 自定义，无 ignorable ✗ |
| `src/deep-rest.js:75,78,87,93,100` | `compaction/*`、`user/message` | DSH 已知 ✓ |

报错只点名 seq 10828，是因为读取碰到第一个未知类型就停了；transform 同样有问题。

**我当时的推理错在哪**：我想的是“seq 10828 能落盘、会话能读，说明 DSH 接受这个类型”。
写日志不校验、读日志才校验 —— 而“验证成功”那次只是因为进程内存里还留着会话状态，
从来没重新读过日志。

## 计划

### 一、立刻止血

让 context-care 不再写自定义事件（否则每次重启都会炸）。
UI 卡片怎么替代，取决于一个待查事实（见下）。

### 二、正统修法

给 `Session.append` 加一个可选参数，把 `ignorable` 透出来。
这正好补上那份 note 承诺的机制。影响面：session 包的签名与测试、SDK 投影；
不动 `SessionEventMap`，不动 `SESSION_FORMAT_VERSION`。

为什么不照建议“复用已有的事件类型”：我把 `KNOWN_SESSION_EVENT_TYPES` 整个列表看了一遍
（`compaction/*`、`plan/mode`、`todo/write`、`session/title`、`workspace/changes`、`tool-workflow/*` …），
没有一个是“某个插件的记录”这一类语义，硬塞就是滥用别人的类型。
而且这不是 context-care 一家的事：任何外部插件都有落日志的需求，缺口在 append 上。

### 三、恢复卡片

带上 ignorable 之后，`loop-clean` / `transform` 可以照原样写回去，UI 卡片照原样工作。

## 待确认

1. **已落盘的历史事件**：哥哥说“临时修复了这个对话” —— 改的是什么？
   （给 DSH 注册了两个类型？改了日志里那两行？还是别的？）这决定要不要写修复脚本，
   也决定别的会话有没有同样的雷。
2. **DSH 本体的改动**由谁做。
3. **界面上渲染的助手消息是日志原文还是投影后（模型可见）的版本？**
   - 若是投影后的：`CLEANED_MARK`（「（这里原本有一段重复输出，已清理）」）本来就在界面上，
     卡片退化成“把这个提示做得更醒目”，不需要新事件；
   - 若是原文：得另找不依赖自定义事件的表达方式。
   这条我自己查。
