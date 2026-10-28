import { createEngine, createEventRuntime, type EventRuntimeOptions, type RuleDeclaration } from '../lib/index.js'

// Compile-only fixture: values prove the public contract, never run a runtime.
declare const save: NonNullable<EventRuntimeOptions['save']>
declare const saveCapacity: EventRuntimeOptions['saveCapacity']
declare const changed: EventRuntimeOptions['changed']
declare const report: EventRuntimeOptions['report']
declare const sinceSeq: EventRuntimeOptions['sinceSeq']
const ports = { save, saveCapacity, changed, report, sinceSeq }
createEventRuntime(ports)
createEngine().events(ports)
createEventRuntime({ sessionAuthoritative: true, saveCapacity, changed, report, sinceSeq })
createEngine().events({ sessionAuthoritative: true, saveCapacity, changed, report, sinceSeq })
// @ts-expect-error independent state cannot acknowledge persistence without a writer
createEventRuntime({ saveCapacity, changed, report, sinceSeq })
// @ts-expect-error engine.events must retain the independent/native discriminant
createEngine().events({ saveCapacity, changed, report, sinceSeq })
// @ts-expect-error capacity storage is a required host capability
createEventRuntime({ save, changed, report, sinceSeq })
// @ts-expect-error an omitted observer cannot silently disable notifications
createEventRuntime({ save, saveCapacity, report, sinceSeq })
// @ts-expect-error background failures require an error reporter
createEventRuntime({ save, saveCapacity, changed, sinceSeq })
// @ts-expect-error policy reset boundaries require an explicit provider
createEventRuntime({ save, saveCapacity, changed, report })
// @ts-expect-error no implicit standalone environment
createEventRuntime()
// @ts-expect-error no implicit environment through the engine facade
createEngine().events()

// Independent plugins retain versioned extension declarations until compilation.
const external: RuleDeclaration = { schemaVersion: 2, sourceId: 'external', id: 'r', revision: 1, on: ['request.assemble'],
  select: { view: 'model', roles: ['user'], blockTypes: ['text'] }, match: { kind: 'all', conditions: [
    { kind: 'extension', ref: 'external:condition', revision: 2, params: { threshold: 3 } }, { kind: 'always' } ] },
  actions: [{ id: 'act', kind: 'extension', ref: 'external:action', revision: 1, stage: 'request.assemble', enabledDefault: true, params: 'value' }] }
createEngine().provideRules('external', () => [external])
