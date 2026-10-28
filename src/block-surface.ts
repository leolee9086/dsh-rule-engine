import type { V2Block } from './block-rules.js'

/** 原生切面可显式提供编辑/深度事实；无此事实时按公开视图和消息顺序计算。 */
export function indexBlockSurfaces(blocks: readonly V2Block[]) {
  // 同一批块只建一次消息目录；深度不能为每个文本子块重新扫描全部历史。
  const messages = new Map<string, number>()
  for (const block of blocks) if (block.messageId !== undefined && !messages.has(block.messageId)) messages.set(block.messageId, messages.size)
  return (block: V2Block) => {
    const placement = block.type === 'reasoning' ? 'reasoning' : block.type === 'tool-call' ? 'tool-call'
      : block.type === 'tool-result' ? 'tool-result' : block.role
    const position = block.messageId === undefined ? undefined : messages.get(block.messageId)
    return { placement, isMarkdown: block.view === 'display', isPrompt: block.view === 'model',
      ...(position === undefined ? {} : { depth: messages.size - 1 - position }), ...block.surface }
  }
}
