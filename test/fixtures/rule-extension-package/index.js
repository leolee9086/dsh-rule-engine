// An independent contributor uses only public capability contracts. It owns no
// condition evaluator, action queue, cooldown cache or delivery journal.
export function installExtension(engine, executors, { word = 'MARK', tool = 'extension-tool' } = {}) {
  const dispose = [
    engine.extensions.registerCondition({ ref: 'example:contains', revision: 1, paramsSchema: { type: 'string' },
      compile: value => ({ kind: 'keywords', mode: 'ALL', values: [word, value] }) }),
    engine.extensions.registerAction({ ref: 'example:record', revision: 1, paramsSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      compile: params => ({ kind: 'tool', executorRef: 'example:record', inputs: params }) }),
    executors.registerTool({ plugin: 'example', executorRef: 'example:record', toolName: tool, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, requiresApproval: false }),
  ]
  return () => { for (const stop of [...dispose].reverse()) stop() }
}
export function installTriggerExtension(engine, runtime) {
  const stopCondition = engine.extensions.registerCondition({ ref: 'example:event', revision: 1, paramsSchema: { type: 'string' },
    compile: value => ({ kind: 'compare', field: 'event.arguments.text', op: 'contains', value }) })
  const stopAction = engine.extensions.registerAction({ ref: 'example:notice', revision: 1, paramsSchema: { type: 'string' },
    compile: template => ({ kind: 'notify', template, delivery: { model: { once: 'surface' } } }) })
  const stopTrigger = runtime.registerCustomEvents([{ name: 'example/changed', nativeEvent: 'test/changed' }])
  return { stopTrigger, dispose() { stopTrigger(); stopAction(); stopCondition() } }
}
export const triggerRule = () => ({ schemaVersion: 2, sourceId: 'example:events', id: 'external-event', revision: 1, on: ['session.event'],
  select: { view: 'original', roles: ['user'], blockTypes: ['text'] }, event: { eventType: 'example/changed' },
  match: { kind: 'all', conditions: [{ kind: 'extension', ref: 'example:event', revision: 1, params: 'ready' },
    { kind: 'not', condition: { kind: 'compare', field: 'event.arguments.text', op: 'contains', value: 'blocked' } }] },
  actions: [{ id: 'model', kind: 'extension', ref: 'example:notice', revision: 1, params: 'EVENT NOTICE', stage: 'session.event', enabledDefault: true }] })
export const extensionRule = () => ({ schemaVersion: 2, sourceId: 'example:source', id: 'external', revision: 1, on: ['request.assemble'],
  select: { view: 'model', roles: ['user'], blockTypes: ['text'] }, match: { kind: 'all', conditions: [
    { kind: 'extension', ref: 'example:contains', revision: 1, params: 'ready' }, { kind: 'not', condition: { kind: 'keywords', mode: 'ANY', values: ['blocked'] } } ] },
  actions: [{ id: 'record', kind: 'extension', ref: 'example:record', revision: 1, params: { text: 'extension-result' }, stage: 'request.assemble', enabledDefault: true, cooldownMs: 1000 }] })
