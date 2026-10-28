import type { StateValue, StickyStateValue } from './event-state.js'
import type { MessageView } from './event-context.js'
export interface EventDeliveryState { actionStarts?: ReadonlyMap<string, number>; windows: StateValue['windows']; stickies: StickyStateValue[]; ticked: Set<string>; committedIds: ReadonlySet<string>; humanId: string; queued: readonly MessageView[] }
