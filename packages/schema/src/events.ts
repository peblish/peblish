import { type } from 'arktype';
import type { AssertNever, Overlap } from './registry.ts';
import { eventAreas, eventSchemas } from './registry/events.gen.ts';

// The versioned outbox event union, assembled from events/<area>.ts (one file per area,
// owned by that area's lane). A new version of an event joins its schema with `.or()`
// under the same key, so rows already in the outbox keep parsing.

export type EventSchemas = typeof eventSchemas;
export type EventType = keyof EventSchemas;
export type EventOf<K extends EventType> = EventSchemas[K]['infer'];
export type OutboxEvent = { [K in EventType]: EventOf<K> }[EventType];

export type DuplicateEventTypes = AssertNever<Overlap<typeof eventAreas>>;
/** Each schema's `type` literal must equal its key. */
export type MisnamedEvents = AssertNever<{ [K in EventType]: EventOf<K>['type'] extends K ? never : K }[EventType]>;

export const eventTypes = Object.keys(eventSchemas) as EventType[];

const Envelope = type({ type: 'string', v: 'number.integer' });

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(eventSchemas, value);
}

/** Validates an event read back from the outbox (or anywhere untrusted). Throws on mismatch. */
export function parseEvent(value: unknown): OutboxEvent {
  const envelope = Envelope.assert(value);
  if (!isEventType(envelope.type)) throw new TypeError(`unknown event type ${envelope.type}`);
  const schema: type.Any<OutboxEvent> = eventSchemas[envelope.type];
  return schema.assert(value);
}
