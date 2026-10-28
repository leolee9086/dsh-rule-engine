import { z } from 'zod'
import { Condition } from './condition-schema.js'
import { BoundJson, Field, Identifier, OwnedJson, parseInput } from './input-schema.js'
import { TextTransform } from './text-transform.js'
import { DeliveryPolicy, EventSelector, Recipient, RuleJudge, ToolDenial, EVENT_STAGES } from './event-policy.js'
import { indexActionAncestors } from './request-action-order.js'
/** 公共运行视图允许阶段和选择切面宽化，但不重新列字段。 */
type UnionKeys<T> = T extends unknown ? keyof T : never
type UnionValue<T, K extends PropertyKey> = T extends unknown ? K extends keyof T ? T[K] : never : never
type ActionShape = z.infer<typeof StageAction>
type ActionCore = Pick<ActionShape, keyof typeof base | 'kind'>
export type V2Target = Omit<z.infer<typeof Target>, 'role'> & { role?: string }
export type SelectFilter = { [K in keyof z.infer<typeof Selection>]: K extends 'view' ? string
  : K extends 'roles' | 'blockTypes' ? readonly string[] : z.infer<typeof Selection>[K] }
export type V2Action = Omit<ActionCore, 'stage'> & { stage: string } & {
  [K in Exclude<UnionKeys<ActionShape>, keyof ActionCore>]?: K extends 'inputs' | 'value' ? unknown
    : K extends 'target' ? V2Target : K extends 'patch' ? Omit<z.infer<typeof Patch>, 'value'> & { value: unknown } : UnionValue<ActionShape, K>
}

export const V2_STAGES = Object.freeze(['request.assemble', 'output.complete', 'tool.result', 'tool.before-execute', 'display.render', 'output.delta', 'tool.succeeded', 'tool.failed', 'request.before', 'assistant.output', 'session.event'] as const)
export const V2_ACTIONS = Object.freeze(['notify', 'guidance', 'inject', 'replace', 'transform', 'filter', 'program', 'tool', 'job', 'set-variable', 'abort', 'resume', 'compact'] as const)
const Stage = z.enum(V2_STAGES), Role = z.enum(['system', 'developer', 'user', 'assistant', 'tool'])
const Milliseconds = z.number().int().min(1).max(86400000), MaxChars = z.number().int().min(1).max(1048576)
const Template = z.string({ error: 'template is required' }).max(16384)
const Target = z.object({ view: z.enum(['model', 'display']), role: Role.optional(), anchor: Identifier.optional(), position: z.enum(['before', 'after']).optional(),
  depth: z.number().int().min(0).max(10000).optional(), lifetime: z.enum(['request', 'turn', 'session']).optional() }).strict()
  .refine(value => (value.anchor === 'depth') === (value.depth !== undefined), 'depth anchor requires depth; depth requires depth anchor')
  .refine(value => value.role !== 'tool', 'tool injection requires a real result')
const Selection = z.object({ view: z.enum(['original', 'model', 'display']), roles: z.array(Role).min(1),
  blockTypes: z.array(z.enum(['text', 'reasoning', 'tool-call', 'tool-result', 'image', 'file', 'unknown'])).min(1),
  depth: z.object({ unit: z.enum(['message', 'turn', 'block']), limit: z.number().int().min(1).max(10000) }).strict().optional(),
  crossBlock: z.boolean().optional(), includeCurrent: z.boolean().optional(), separator: z.string().max(4096).optional(),
}).strict().refine(value => !value.crossBlock || value.separator !== undefined, 'crossBlock requires an explicit separator')
const base = {
  id: Identifier, stage: Stage, enabledDefault: z.boolean(), cooldownMs: z.number().int().min(0).max(86400000).default(0),
  dedupe: z.object({ mode: z.enum(['occurrence', 'none']) }).strict().default({ mode: 'occurrence' }),
  dependsOn: z.array(Identifier).max(64).default([]).refine(value => new Set(value).size === value.length, 'duplicate dependency'),
  failurePolicy: z.enum(['skip-dependents', 'continue']).optional(), delivery: DeliveryPolicy.optional(), deny: ToolDenial.optional(),
}
function action<const K extends typeof V2_ACTIONS[number], S extends z.ZodRawShape>(kind: K, fields: S) {
  return z.strictObject({ ...base, kind: z.literal(kind), ...fields }, { error: issue => issue.code === 'unrecognized_keys' ? `unknown ${kind} action` : undefined })
}
const Notice = { template: Template, maxChars: MaxChars.optional(), target: Target.optional() }
const Execution = { executorRef: Identifier, inputs: BoundJson.optional(), timeoutMs: Milliseconds.optional() }
const Patch = z.object({ kind: z.literal('tool-arguments'), path: Field.refine(path => path.startsWith('/'), 'patch requires JSON Pointer'), value: BoundJson }).strict()
  .refine(value => Object.hasOwn(value, 'value'), 'patch value is required')
export const StageAction = z.discriminatedUnion('kind', [
  action('notify', Notice), action('guidance', Notice), action('inject', Notice),
  action('replace', { template: Template.optional(), maxChars: MaxChars.optional(), patch: Patch.optional() })
    .refine(value => value.patch === undefined ? value.template !== undefined : value.template === undefined, 'replace requires template or argument patch; argument patch cannot also replace text'),
  action('transform', { transform: TextTransform, condition: Condition.optional(), maxChars: MaxChars.optional() }),
  action('filter', {}), action('program', Execution), action('tool', Execution), action('job', Execution),
  action('set-variable', { variable: Identifier, value: BoundJson }).refine(value => Object.hasOwn(value, 'value'), 'variable value is required'),
  action('abort', {}), action('resume', { template: Template, maxChars: MaxChars.optional() }),
  action('compact', { template: Template, maxChars: MaxChars.optional(), timeoutMs: Milliseconds.optional() }),
]).superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  if (value.kind === 'transform' && value.stage !== 'request.assemble' && value.stage !== 'display.render') issue('text transformation requires a request or display copy')
  if ('target' in value && value.target) {
    if (value.target.view !== (value.stage === 'display.render' ? 'display' : 'model')) issue('target view does not match action stage')
    if ((value.kind === 'notify' || value.kind === 'guidance') && Object.keys(value.target).some(key => key !== 'view' && key !== 'lifetime')) issue('notice target only supports view and lifetime')
  }
  if (value.stage === 'output.delta' && ['program', 'tool', 'job', 'replace', 'transform', 'filter', 'set-variable', 'compact'].includes(value.kind)) issue('action requires a complete block')
  if (value.stage === 'display.render' && !['inject', 'replace', 'transform', 'filter'].includes(value.kind)) issue('display actions must be pure')
})

/** 字段形状、默认值和关系约束只在这份 schema 中定义。 */
export const StageFieldsSchema = z.object({ schemaVersion: z.literal(2), sourceId: Identifier, id: Identifier, revision: z.number().int().positive(),
  title: z.string().max(4096).optional(), description: z.string().max(16384).optional(), on: z.array(Stage).min(1), select: Selection, match: Condition,
  actions: z.array(StageAction).min(1).max(64), priority: z.number().int().min(-100000).max(100000).default(0), exclusiveGroup: Identifier.optional(),
  recipient: Recipient.optional(), event: EventSelector.optional(), judge: RuleJudge.optional(),
}).strict().superRefine((rule, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  const byId = new Map(rule.actions.map(action => [action.id, action]))
  if (byId.size !== rule.actions.length) issue('duplicate action id')
  for (const action of rule.actions) {
    if (!rule.on.includes(action.stage)) issue('action stage must be declared in on')
    for (const ref of action.dependsOn) {
      const parent = byId.get(ref)
      if (!parent) issue(`missing dependency ${ref}`)
      else if (parent.stage !== action.stage) issue('dependency must use the same stage')
    }
    if (action.kind === 'resume' && (action.failurePolicy === 'continue' || !action.dependsOn.some(ref => byId.get(ref)?.kind === 'abort'))) issue('resume requires a successful same-stage abort dependency')
    if (action.delivery) {
      if (!EVENT_STAGES.includes(action.stage) || (action.kind !== 'notify' && action.kind !== 'guidance')) issue('delivery requires an event notification action')
      if (action.deny && action.stage !== 'tool.before-execute') issue('deny-tool requires on: tool.before-execute')
      const model = action.delivery.model
      if ((model.once === 'window' || model.shared?.reset === 'window') && !rule.event?.timeWindow) issue('window delivery or shared window quota requires event.timeWindow')
      if (model.sticky && model.once === 'surface') issue('sticky cannot combine with once: surface')
      if (model.once === 'none' && !model.sticky) issue('once: none requires sticky')
      if (model.interrupt && action.stage !== 'assistant.output') issue('abort-resume requires on: assistant.output')
    }
  }
  try {
    const ancestors = indexActionAncestors(rule.actions)
    const phase = (action: z.infer<typeof StageAction>) => action.kind === 'transform' ? 1
      : action.stage === 'display.render' || action.stage === 'request.assemble' && ['replace', 'filter', 'inject', 'guidance'].includes(action.kind) ? 0 : 2
    for (const action of rule.actions) if (rule.actions.some(parent => ancestors.get(action.id)?.has(parent.id)
      && (action.kind === 'transform' && phase(parent) > 1 || phase(action) === 0 && parent.kind === 'transform'))) issue('action dependency reads a later execution phase')
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'action-dependency-cycle') throw error
    issue('cyclic action dependency')
  }
})
/** 运行端允许筛选动作/阶段列表；字段约束仍由上面的 schema 唯一定义。 */
export type StageFields = Omit<z.infer<typeof StageFieldsSchema>, 'actions' | 'on' | 'select'> & { actions: V2Action[]; on: string[]; select: SelectFilter }
export function normalizeStageFields(input: unknown): StageFields {
  parseInput(OwnedJson, input, 'stage rule')
  return parseInput(StageFieldsSchema, input, 'stage rule')
}
