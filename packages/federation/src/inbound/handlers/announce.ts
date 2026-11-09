import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { follows } from '@peblish/core/db/tables/follows';
import { and, eq } from 'drizzle-orm';
import { fetchActivity, FetchFailure } from '../../actors/document.ts';
import { activityFromWire } from '../../mapping/activity.ts';
import { fromWire } from '../../mapping/document.ts';
import { MappingError, type JsonObject } from '../../mapping/json.ts';
import type { Activity, ContentObject } from '../../mapping/records.ts';
import { checkActivityOrigin, checkNotEcho } from '../authorize.ts';
import type { InboundContext, InboundHandler } from '../handler.ts';
import { skip } from '../reasons.ts';

// The community's Announce (FEP-1b12): a remote community wraps what happened in it and sends
// it to its followers. It carries no change of its own; this handler vets the announcement and
// hands the activity inside to that activity's handler, with the community recorded as the
// one that vouched for it (the principal's announcedBy, which core's policies read).
//
// - Only a community announces. A Person's Announce is a boost, not a relay (ignored).
// - Only a community someone here follows. Nothing else was asked for.
// - The activity inside speaks for its own actor's server. An activity on the announcer's own
//   origin is read as embedded; one from another origin (Lemmy announcing a PieFed user's
//   post) is read again from its own origin, and refused if that origin does not serve it, so a
//   community cannot put words in the mouth of someone else's server (spike N10 and N11).
// - A Page or Note announced bare (the Mastodon copy Lemmy sends every follower) is stored
//   like its Create; whichever copy arrives first wins and the other is a no-op.

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const originOf = (url: string) => new URL(url).origin;

type Announced = { activity: Activity; raw: JsonObject; content: ContentObject | null };

/** What an Announce carries as an activity: a bare Page or Note is the Create of itself. */
function announced(object: Activity | ContentObject, raw: JsonObject): Announced {
  if (object.type !== 'Page' && object.type !== 'Note') return { activity: object, raw, content: null };
  const [id, actorApId, communityApId] =
    object.type === 'Page'
      ? [object.post.apId, object.post.authorApId, object.post.communityApId]
      : [object.comment.apId, object.comment.authorApId, object.comment.communityApId];
  return { activity: { id, actorApId, communityApId, raw, type: 'Create', object }, raw, content: object };
}

/** The announced thing as its own origin serves it, or a skip when it does not serve it. */
async function readFromOrigin(ctx: InboundContext, expected: Announced): Promise<Announced> {
  const { id, actorApId } = expected.activity;
  let json: unknown;
  try {
    json = (await fetchActivity(id, ctx.fetch)).json;
  } catch (error) {
    // The origin being down is retried; its saying no is the answer.
    if (error instanceof FetchFailure && (error.reason === 'unreachable' || (error.status !== undefined && error.status >= 500)))
      throw error;
    if (error instanceof FetchFailure) throw skip('embedded.unverifiable', id);
    throw error;
  }
  if (!isObject(json) || json.id !== id) throw skip('embedded.unverifiable', id);
  try {
    if (expected.content) {
      const mapped = fromWire(json);
      const content: ContentObject | null =
        mapped.kind === 'post'
          ? { type: 'Page', post: mapped.post }
          : mapped.kind === 'comment'
            ? { type: 'Note', comment: mapped.comment }
            : null;
      if (!content) throw skip('embedded.unverifiable', id);
      const read = announced(content, json);
      if (read.activity.actorApId !== actorApId) throw skip('embedded.unverifiable', id);
      return read;
    }
    const activity = activityFromWire(json);
    if (activity.type !== expected.activity.type || activity.actorApId !== actorApId) throw skip('embedded.unverifiable', id);
    return { activity, raw: json, content: null };
  } catch (error) {
    if (error instanceof MappingError) throw skip('embedded.unverifiable', id);
    throw error;
  }
}

async function followedHere(communityId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: follows.id })
    .from(follows)
    .innerJoin(actors, eq(actors.id, follows.followerId))
    .where(and(eq(follows.followeeId, communityId), eq(actors.local, true)))
    .limit(1);
  return rows.length > 0;
}

export const handler: InboundHandler = {
  type: 'Announce',
  async prepare(ctx) {
    const { activity, sender: community } = ctx;
    if (activity.type !== 'Announce') throw new TypeError('the Announce handler was given another activity');
    if (community.kind !== 'Group') throw skip('announce.person', community.apId);
    const embedded = ctx.raw.object;
    if (!isObject(embedded)) throw skip('announce.bare_iri');
    let inner = announced(activity.object, embedded);
    // Our own activity coming back, or a copy already applied, is dropped before anything is fetched.
    checkNotEcho(inner.activity, ctx.origin);
    if (await ctx.seen(inner.activity.id)) throw skip('duplicate');
    if (!(await followedHere(community.id))) throw skip('announce.unfollowed', community.apId);
    if (!inner.content) checkActivityOrigin(inner.activity);
    if (originOf(inner.activity.id) !== originOf(activity.id)) inner = await readFromOrigin(ctx, inner);
    const handler = ctx.handlerFor(inner.activity.type);
    if (!handler) throw skip('type.unhandled', inner.activity.type);
    return handler.prepare(await ctx.nested(inner.activity, inner.raw, { apId: activity.id, community }));
  },
};
