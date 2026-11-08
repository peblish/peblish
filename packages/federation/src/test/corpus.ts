import { fromWire, toWire } from '../mapping/document.ts';
import type { Mapped } from '../mapping/records.ts';
import { diff, matches, type Change, type Difference } from './diff.ts';
import { vocabulary } from './vocabulary.ts';

// The round trip every corpus entry goes through (manifest entries in the tests, the archive
// subset in tools/fixture-import): wire to record, record back to wire, then the diff.

export function roundTrip(json: unknown): { mapped: Mapped; back: unknown; differences: Difference[] } {
  const mapped = fromWire(json);
  const back = toWire(mapped);
  return { mapped, back, differences: diff(json, back) };
}

/** The documented vocabulary entry that explains a difference, if any. */
export function explain(difference: { path: string; change: Change }): string | undefined {
  return vocabulary.find(
    (entry) => entry.changes.includes(difference.change) && entry.paths.some((pattern) => matches(pattern, difference.path)),
  )?.key;
}

/** The peblish entity a document maps to, for the manifest. */
export const Entities = [
  'actor',
  'community',
  'post',
  'comment',
  'vote',
  'follow',
  'report',
  'moderators',
  'deletion',
  'lock',
  'pin',
  'ban',
] as const;
export type Entity = (typeof Entities)[number];

export function entityOf(mapped: Mapped): Entity {
  switch (mapped.kind) {
    case 'actor':
      return mapped.actor.kind === 'Group' ? 'community' : 'actor';
    case 'post':
    case 'comment':
    case 'moderators':
      return mapped.kind;
    case 'activity': {
      let activity = mapped.activity;
      while (true) {
        switch (activity.type) {
          case 'Create':
          case 'Update':
            if (activity.object.type === 'Actor') return activity.object.actor.kind === 'Group' ? 'community' : 'actor';
            return activity.object.type === 'Page' ? 'post' : 'comment';
          case 'Announce':
            if (activity.object.type === 'Page') return 'post';
            if (activity.object.type === 'Note') return 'comment';
            activity = activity.object;
            continue;
          case 'Undo':
            activity = activity.object;
            continue;
          case 'Like':
          case 'Dislike':
            return 'vote';
          case 'Follow':
          case 'Accept':
          case 'Reject':
            return 'follow';
          case 'Flag':
            return 'report';
          case 'Delete':
            return 'deletion';
          case 'Lock':
            return 'lock';
          case 'Add':
          case 'Remove':
            return activity.targetApId.endsWith('/moderators') ? 'moderators' : 'pin';
          case 'Block':
            return 'ban';
        }
      }
    }
  }
}

/** `Create(Page)`, `Announce(Undo(Like))`, `Group`: the shape label of a document. */
export function shapeOf(json: unknown): string {
  if (typeof json !== 'object' || json === null || !('type' in json)) return 'unknown';
  const object = 'object' in json ? json.object : undefined;
  const inner = typeof object === 'object' && object !== null && 'type' in object ? `(${shapeOf(object)})` : '';
  return `${String(json.type)}${inner}`;
}
