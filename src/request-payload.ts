/** Detach one owned payload tree before visiting any descendant block. */
export function ownRequestMessageBody<C, S>(message: { content: C; source?: S }): { content: C; source: S | undefined } {
  return structuredClone({ content: message.content, source: message.source || undefined })
}

/** Write only to a planner-owned request. Native origins are supplied by the Host. */
export function setRequestBlock(request: { system?: string; messages: { content: unknown[] }[] }, block: { messageIndex: number; path: string }, value: unknown): void {
  if (block.messageIndex === -1) {
    if (value === undefined) throw new Error('request-system-filter-denied')
    if (value === null || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') throw new TypeError('request-system-text-required')
    request.system = value.text; return
  }
  let content = request.messages[block.messageIndex].content
  const indices = block.path.split('.').map(Number)
  for (const index of indices.slice(0, -1)) {
    const parent = content[index]
    if (parent === null || typeof parent !== 'object' || !('content' in parent) || !Array.isArray(parent.content)) throw new TypeError('request-block-parent-unavailable')
    content = parent.content
  }
  const index = indices[indices.length - 1]
  if (value === undefined) content.splice(index, 1)
  else content[index] = value
}
