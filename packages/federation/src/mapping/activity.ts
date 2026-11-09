import { actorFromWire, actorToWire } from './actor.ts';
import { commentFromNote, commentToNote, communityOf, postFromPage, postToPage } from './content.ts';
import { type } from 'arktype';
import { compact, MappingError, parse, type Json, type JsonObject } from './json.ts';
import type { Activity, ContentObject, FollowActivity } from './records.ts';
import { followersOf, PUBLIC } from './vocabulary.ts';
import { Ref, refId, WireActivity } from './wire.ts';

const contentTypes = new Set(['Page', 'Article', 'Video', 'Note']);
const actorTypes = new Set(['Person', 'Group', 'Application', 'Service']);

/** The IRI of an activity's object, whether sent bare or embedded (a Tombstone, a Mastodon Flag's first object). */
function objectId(object: unknown, what: string): string {
  const first = Array.isArray(object) ? object[0] : object;
  const ref = Ref(first);
  if (ref instanceof type.errors) throw new MappingError(`${what}: object must be an IRI or carry an id`);
  return refId(ref);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function contentFromWire(json: unknown): ContentObject {
  if (isObject(json) && json.type === 'Note') return { type: 'Note', comment: commentFromNote(json) };
  return { type: 'Page', post: postFromPage(json) };
}

export function contentToWire(object: ContentObject): JsonObject {
  return object.type === 'Page' ? postToPage(object.post) : commentToNote(object.comment);
}

/** How many activities may nest inside a top-level one: Announce(Undo(Like)) uses two. Deeper input is refused, not recursed into. */
const MAX_DEPTH = 3;

/** An activity document (top level or embedded, at `depth` levels down) to the activity and the record it carries. */
export function activityFromWire(json: unknown, depth = 0): Activity {
  if (depth > MAX_DEPTH) throw new MappingError(`activities nest more than ${MAX_DEPTH} deep`);
  const activity = parse(WireActivity, json, 'activity');
  const actorApId = refId(activity.actor);
  const id = activity.id;
  // Only audience names the community for votes; for the moderation and content verbs Lemmy also puts it in cc.
  const community = (fallback: boolean) => activity.audience ?? (fallback ? communityOf(activity, actorApId) : null);
  const envelope = { id, actorApId, raw: json };
  const object = activity.object;
  switch (activity.type) {
    case 'Update':
      if (isObject(object) && typeof object.type === 'string' && actorTypes.has(object.type)) {
        return { ...envelope, type: 'Update', communityApId: community(true), object: { type: 'Actor', actor: actorFromWire(object) } };
      }
      return { ...envelope, type: 'Update', communityApId: community(true), object: contentFromWire(object) };
    case 'Create':
      return { ...envelope, type: 'Create', communityApId: community(true), object: contentFromWire(object) };
    case 'Like':
    case 'Dislike':
      return {
        ...envelope,
        type: activity.type,
        communityApId: community(false),
        vote: {
          apId: id,
          voterApId: actorApId,
          targetApId: objectId(object, activity.type),
          value: activity.type === 'Like' ? 1 : -1,
          raw: json,
        },
      };
    case 'Follow':
      return {
        ...envelope,
        type: 'Follow',
        communityApId: null,
        follow: { apId: id, followerApId: actorApId, followeeApId: objectId(object, 'Follow') },
      };
    case 'Accept':
    case 'Reject': {
      const follow = activityFromWire(object, depth + 1);
      if (follow.type !== 'Follow') throw new MappingError(`${activity.type} must embed the Follow it answers`);
      return { ...envelope, type: activity.type, communityApId: null, object: follow };
    }
    case 'Announce': {
      if (!isObject(object)) throw new MappingError('Announce of a bare IRI: fetch the object, then map it');
      const inner =
        typeof object.type === 'string' && contentTypes.has(object.type) ? contentFromWire(object) : activityFromWire(object, depth + 1);
      return { ...envelope, type: 'Announce', communityApId: actorApId, object: inner };
    }
    case 'Delete':
      return {
        ...envelope,
        type: 'Delete',
        communityApId: community(true),
        objectApId: objectId(object, 'Delete'),
        reason: activity.summary ?? null,
        ...(typeof activity.removeData === 'boolean' && { removeData: activity.removeData }),
      };
    case 'Undo': {
      if (!isObject(object)) throw new MappingError('Undo must embed the activity it reverses');
      return { ...envelope, type: 'Undo', communityApId: community(true), object: activityFromWire(object, depth + 1) };
    }
    case 'Lock':
      return { ...envelope, type: 'Lock', communityApId: community(true), objectApId: objectId(object, 'Lock') };
    case 'Flag': {
      const communityApId = community(true);
      return {
        ...envelope,
        type: 'Flag',
        communityApId,
        report: {
          apId: id,
          reporterApId: actorApId,
          targetApId: objectId(object, 'Flag'),
          communityApId,
          reason: activity.summary ?? activity.content ?? null,
          raw: json,
        },
      };
    }
    case 'Add':
    case 'Remove':
      if (!activity.target) throw new MappingError(`${activity.type} names no target collection`);
      return {
        ...envelope,
        type: activity.type,
        communityApId: community(true),
        objectApId: objectId(object, activity.type),
        targetApId: refId(activity.target),
      };
    case 'Block': {
      if (!activity.target) throw new MappingError('Block names no target community or instance');
      const expires = activity.expires ?? activity.endTime;
      return {
        ...envelope,
        type: 'Block',
        communityApId: community(true),
        objectApId: objectId(object, 'Block'),
        targetApId: refId(activity.target),
        reason: activity.summary ?? null,
        removeData: activity.removeData ?? null,
        expires: expires ? new Date(expires) : null,
      };
    }
    default:
      throw new MappingError(`activity type ${activity.type} is not mapped`);
  }
}

/** Lemmy's addressing for each verb: what goes in `to` and `cc`, and whether `audience` is set. */
function addressing(activity: Activity): { to?: string[]; cc?: string[]; audience?: string } {
  const community = activity.communityApId ?? undefined;
  const publicToCommunity = { to: [PUBLIC], cc: community ? [community] : [], audience: community };
  switch (activity.type) {
    case 'Like':
    case 'Dislike':
      return { audience: community };
    case 'Follow':
      return { to: [activity.follow.followeeApId] };
    case 'Accept':
    case 'Reject':
      return { to: [activity.object.follow.followerApId] };
    case 'Announce':
      return { to: [PUBLIC], cc: [followersOf(activity.actorApId)] };
    case 'Flag':
      return { to: community ? [community] : [], audience: community };
    case 'Undo':
      return activity.object.type === 'Follow' || activity.object.type === 'Like' || activity.object.type === 'Dislike'
        ? { ...addressing(activity.object), audience: community }
        : publicToCommunity;
    default:
      return publicToCommunity;
  }
}

function followToWire(follow: FollowActivity): JsonObject {
  return { id: follow.id, type: 'Follow', actor: follow.actorApId, object: follow.follow.followeeApId };
}

/** An activity to its document in the Lemmy dialect, without @context (toWire adds it at the top level). */
export function activityToWire(activity: Activity): JsonObject {
  const head = { id: activity.id, type: activity.type, actor: activity.actorApId, ...addressing(activity) };
  const body = ((): Record<string, Json | undefined> => {
    switch (activity.type) {
      case 'Create':
      case 'Update':
        return { object: activity.object.type === 'Actor' ? actorToWire(activity.object.actor) : contentToWire(activity.object) };
      case 'Like':
      case 'Dislike':
        return { object: activity.vote.targetApId };
      case 'Follow':
        return { object: activity.follow.followeeApId };
      case 'Accept':
      case 'Reject':
        return { object: followToWire(activity.object) };
      case 'Announce': {
        const inner = activity.object;
        return { object: inner.type === 'Page' || inner.type === 'Note' ? contentToWire(inner) : activityToWire(inner) };
      }
      case 'Delete':
        return { object: activity.objectApId, summary: activity.reason ?? undefined, removeData: activity.removeData };
      case 'Undo':
        return { object: activityToWire(activity.object) };
      case 'Lock':
        return { object: activity.objectApId };
      case 'Flag':
        return { object: activity.report.targetApId, summary: activity.report.reason ?? undefined };
      case 'Add':
      case 'Remove':
        return { object: activity.objectApId, target: activity.targetApId };
      case 'Block':
        return {
          object: activity.objectApId,
          target: activity.targetApId,
          summary: activity.reason ?? undefined,
          removeData: activity.removeData ?? undefined,
          expires: activity.expires?.toISOString(),
        };
    }
  })();
  return compact({ ...head, ...body });
}

/**
 * A community's Announce of another server's activity, embedding its JSON as received
 * (FEP-1b12). Fedify's serializer must not touch `object`: JSON-LD compaction collapses
 * one-element arrays and drops terms, which Lemmy's strict parser rejects (spike finding).
 */
export function announceJson(id: string, communityApId: string, object: JsonObject): JsonObject {
  return { id, type: 'Announce', actor: communityApId, to: [PUBLIC], object, cc: [followersOf(communityApId)] };
}
