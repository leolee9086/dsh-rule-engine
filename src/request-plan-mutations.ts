import { isRecord } from './guard.js'

/** 数组也允许按自身属性读取；该谓词用于结构化克隆后的写入目标。 */
function propertyObject(value: unknown): value is Record<string, unknown> {
  return Array.isArray(value) || isRecord(value)
}

interface PathNode { terminal: boolean; children: Map<string, PathNode> }
const pathNode = (): PathNode => ({ terminal: false, children: new Map() })

/** One block owns one clone. Records still need complete JSON snapshots, but
 * writing an unrelated property no longer clones every other property again.
 * The conflict trie deliberately uses RAW pointer components: the old policy
 * compared encoded paths, not decoded property aliases. */
export function createArgumentPatchState(original: unknown, worked: (amount: number) => void = () => {}) {
  const paths = pathNode()
  let owned: unknown, initialized = false, serialized: string | undefined
  return {
    conflicts(pointer: string): boolean {
      let node = paths
      for (const part of pointer.split('/')) {
        worked(1)
        if (node.terminal) return true
        const next = node.children.get(part)
        if (!next) return false
        node = next
      }
      return node.terminal || node.children.size > 0
    },
    apply(pointer: string, value: unknown) {
      if (!initialized) { owned = structuredClone(original); serialized = JSON.stringify(owned); initialized = true; worked(1) }
      if (!pointer.startsWith('/') || !pointer.slice(1)) throw new Error('tool-argument-patch-requires-property')
      const keys = pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'))
      if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('tool-argument-patch-unsafe-path')
      let parent = owned
      for (const key of keys.slice(0, -1)) {
        worked(1)
        if (!propertyObject(parent) || !Object.hasOwn(parent, key)) throw new Error('tool-argument-patch-missing-path')
        parent = parent[key]
      }
      const last = keys[keys.length - 1]
      if (!propertyObject(parent) || !Object.hasOwn(parent, last)) throw new Error('tool-argument-patch-missing-path')
      const target = parent, previous = target[last], before = serialized
      target[last] = value
      let after: string | undefined
      try { after = JSON.stringify(owned) } catch (error) { target[last] = previous; throw error }
      serialized = after
      let node = paths
      for (const part of pointer.split('/')) {
        worked(1)
        let next = node.children.get(part)
        if (!next) { next = pathNode(); node.children.set(part, next) }
        node = next
      }
      node.terminal = true
      return { before, after }
    },
  }
}

export interface RequestInsertion { at: number; priority: number; key: string; role: string; text: string }
/** Match the old descending sort/splice exactly, including same-key stable
 * ties. Only materialize each insertion once, then merge original rows once.
 * System prepend/append order remains the old execution order and never
 * consumes a message position. */
export function mergeRequestInsertions<M, I extends RequestInsertion>(messages: readonly M[], system: string | undefined, insertions: readonly I[], message: (insertion: I) => M) {
  const sorted = [...insertions].sort((a, b) => b.at - a.at || a.priority - b.priority || b.key.localeCompare(a.key))
  const added: { at: number; message: M }[] = [], prepends: string[] = [], appends: string[] = []
  let hasSystem = false
  for (const insertion of sorted) {
    if (insertion.role === 'system') { hasSystem = true; if (insertion.at === 0) prepends.push(insertion.text); else appends.push(insertion.text) }
    else added.push({ at: Math.min(messages.length, Math.max(0, Math.trunc(insertion.at))), message: message(insertion) })
  }
  const output: M[] = []
  let next = added.length - 1
  for (let at = 0; at <= messages.length; at++) {
    while (next >= 0 && added[next].at === at) output.push(added[next--].message)
    if (at < messages.length) output.push(messages[at])
  }
  // Original system can be absent; preserve undefined unless a system action
  // actually executes. Empty prepend/append text still adds its newline.
  const parts = [...prepends.reverse(), system ?? '', ...appends]
  return { messages: output, system: hasSystem ? parts.join('\n') : system, hasSystem }
}
