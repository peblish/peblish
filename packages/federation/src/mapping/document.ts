import { activityFromWire, activityToWire } from './activity.ts';
import { actorFromWire, actorToWire, moderatorsFromWire, moderatorsToWire } from './actor.ts';
import { commentFromNote, commentToNote, postFromPage, postToPage } from './content.ts';
import { MappingError, type JsonObject } from './json.ts';
import type { Mapped } from './records.ts';
import { LEMMY_CONTEXT } from './vocabulary.ts';

const actorTypes = new Set(['Person', 'Group', 'Application', 'Service']);
const postTypes = new Set(['Page', 'Article', 'Video']);

/** Any top-level document a peer sends or serves (an actor, a post, a comment, a moderators collection or an activity). */
export function fromWire(json: unknown): Mapped {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new MappingError('a document is a JSON object');
  const type = 'type' in json ? json.type : undefined;
  if (typeof type !== 'string') throw new MappingError('document has no type');
  if (actorTypes.has(type)) return { kind: 'actor', actor: actorFromWire(json) };
  if (postTypes.has(type)) return { kind: 'post', post: postFromPage(json) };
  if (type === 'Note') return { kind: 'comment', comment: commentFromNote(json) };
  if (type === 'OrderedCollection') return { kind: 'moderators', moderators: moderatorsFromWire(json) };
  return { kind: 'activity', activity: activityFromWire(json) };
}

/** The document peblish serves or sends for `mapped`, with Lemmy's @context at the top. */
export function toWire(mapped: Mapped): JsonObject {
  const body = (() => {
    switch (mapped.kind) {
      case 'actor':
        return actorToWire(mapped.actor);
      case 'post':
        return postToPage(mapped.post);
      case 'comment':
        return commentToNote(mapped.comment);
      case 'moderators':
        return moderatorsToWire(mapped.moderators);
      case 'activity':
        return activityToWire(mapped.activity);
    }
  })();
  return { '@context': LEMMY_CONTEXT, ...body };
}
