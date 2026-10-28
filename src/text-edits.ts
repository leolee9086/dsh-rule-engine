/** 所有文本动作的共同 UTF-16 编辑内核；调用方先决定坐标与冲突策略。 */
export interface TextEdit { range: readonly number[]; text: string }
const rank = (value: number) => { value = Math.imul(value ^ value >>> 16, 0x45d9f3b); value = Math.imul(value ^ value >>> 16, 0x45d9f3b); return (value ^ value >>> 16) >>> 0 }

// UTF-16 piece rope: splice spans, not whole strings. This also preserves the
// engine's surprising same-start zero-width order and short duplicate rows.
interface Piece { source: string; from: number; to: number; length: number; rank: number; left?: Piece; right?: Piece }
export function materializeText(text: string, patches: readonly TextEdit[]): string {
  let serial = 0
  const length = (node?: Piece) => node?.length ?? 0
  const update = (node: Piece) => { node.length = length(node.left) + node.to - node.from + length(node.right); return node }
  const piece = (source: string, from = 0, to = source.length): Piece | undefined => from === to ? undefined : { source, from, to, length: to - from, rank: rank(++serial) }
  function merge(a?: Piece, b?: Piece): Piece | undefined {
    if (!a || !b) return a ?? b
    if (a.rank < b.rank) { a.right = merge(a.right, b); return update(a) }
    b.left = merge(a, b.left); return update(b)
  }
  function split(node: Piece | undefined, at: number): [Piece | undefined, Piece | undefined] {
    if (!node) return [undefined, undefined]
    const left = length(node.left), size = node.to - node.from
    if (at < left) { const [a, b] = split(node.left, at); node.left = b; return [a, update(node)] }
    if (at > left + size) { const [a, b] = split(node.right, at - left - size); node.right = a; return [update(node), b] }
    const offset = Math.min(size, Math.max(0, at - left))
    return [merge(node.left, piece(node.source, node.from, node.from + offset)), merge(piece(node.source, node.from + offset, node.to), node.right)]
  }
  let root = piece(text)
  for (const patch of patches) {
    const [left, tail] = split(root, patch.range[0]), [, right] = split(tail, patch.range[1] - patch.range[0])
    root = merge(merge(left, piece(patch.text)), right)
  }
  const chunks: string[] = []
  function visit(node?: Piece) { if (node) { visit(node.left); chunks.push(node.source.slice(node.from, node.to)); visit(node.right) } }
  visit(root); return chunks.join('')
}

/** 正则先读取同一份输入，再将匹配降为基线编辑。替换中的宏仍按从左到右求值。 */
export function replaceText(text: string, regex: RegExp, render: (match: string, ...args: unknown[]) => string): string {
  const single = regex.global ? undefined : regex.exec(text)
  const matches = regex.global ? [...text.matchAll(regex)] : single ? [single] : []
  const edits = matches.map(match => {
    const args: unknown[] = [...match.slice(1), match.index, text]
    if (match.groups !== undefined) args.push(match.groups)
    return { range: [match.index, match.index + match[0].length], text: render(match[0], ...args) }
  })
  return materializeText(text, edits.reverse())
}
