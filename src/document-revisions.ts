import type { RuleDocument } from './declarations.js'
import { documentRule } from './declarations.js'

/** 作者显式推进版本；变更声明不能复用旧的成功、冷却和证据身份。 */
export function assertFileRevision(previous: RuleDocument | undefined, next: RuleDocument): void {
  if (!previous || previous.id !== next.id || JSON.stringify(previous) === JSON.stringify(next)) return
  if (next.revision <= previous.revision) throw new Error('rule-file-document-needs-new-revision')
  for (const field of ['rules', 'entries', 'partials']) {
    const before: readonly Record<string, unknown>[] = field === 'rules' ? previous.rules.map(documentRule) : field === 'entries' ? previous.entries : previous.partials
    const after: readonly Record<string, unknown>[] = field === 'rules' ? next.rules.map(documentRule) : field === 'entries' ? next.entries : next.partials
    for (const item of after) {
      const old = before.find(value => field === 'partials' ? value.name === item.name : value.id === item.id)
      if (old && (Number(item.revision) < Number(old.revision) || JSON.stringify(old) !== JSON.stringify(item) && item.revision === old.revision))
        throw new Error(`rule-file-${field}-needs-new-revision`)
    }
  }
}
