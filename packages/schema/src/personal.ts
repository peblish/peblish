import type { EventType } from './events.ts';

/**
 * The events of the personal features (saves, sidebar pins, thread follows, visit markers).
 * What they record stays on this server: no federation consumer sends anything for them, and
 * federation's personal-events test runs every one of its consumers over each to prove it.
 */
export const personalEventTypes = [
  'save.added',
  'save.removed',
  'pin.added',
  'pin.removed',
  'pin.moved',
  'watch.added',
  'watch.removed',
  'visit.recorded',
] as const satisfies readonly EventType[];
export type PersonalEventType = (typeof personalEventTypes)[number];

export const isPersonalEventType = (type: string): type is PersonalEventType => personalEventTypes.some((personal) => personal === type);
