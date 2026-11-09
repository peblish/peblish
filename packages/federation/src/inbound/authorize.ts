import { authorize } from '@peblish/core/authz/authorize';
import type { Authorized } from '@peblish/core/authz/brand';
import type { ActionName, SubjectOf } from '@peblish/core/authz/policy';
import { db, type Queryable } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { comments, posts } from '@peblish/core/db/tables/content';
import type { Tx } from '@peblish/core/tx/tx';
import type { ActingPrincipal } from '@peblish/schema/authz';
import { and, eq, inArray } from 'drizzle-orm';
import type { ResolvedActor } from '../actors/resolve.ts';
import type { Activity } from '../mapping/records.ts';
import { many } from '../mapping/wire.ts';
import type { InboundContext } from './handler.ts';
import { skip } from './reasons.ts';

// The one module that decides whether an inbound activity may change state here. The spike's
// rules (spikes/fedify-threadiverse/src/{authz,inbox}.ts), with the roles left to core:
//
// - Origins. A server speaks only for its own people: an activity's id and actor share an
//   origin, a created or updated object lives on its author's origin and names the actor as
//   its author, and an activity embedded in an Announce is either on the announcer's origin or
//   read from its own (pipeline.ts, announce.ts). An Undo reverses only the actor's own.
// - The community. An activity names a community (audience, or the Group it is addressed to);
//   that must be the community of what it is about. Content in a remote community counts only
//   inside that community's own Announce, and an Announce vouches only for its own community
//   (`mod.announce_mismatch`, as core's policies read it).
// - Roles. Who may do what to the target is core's: the principal below is handed to
//   authorize(), whose policies answer owner, moderator or the community's Announce
//   (decision 10) with the exact refusal.

const originOf = (url: string): string => new URL(url).origin;

/** The activity's id and its actor are on one origin. */
export function checkActivityOrigin(activity: Activity): void {
  if (originOf(activity.id) !== originOf(activity.actorApId)) {
    throw skip('activity.origin_mismatch', `${originOf(activity.id)} speaks for ${originOf(activity.actorApId)}`);
  }
}

/** An activity of ours coming back through a relay is dropped before anything is fetched. */
export function checkNotEcho(activity: Activity, localOrigin: string): void {
  if (originOf(activity.id) === localOrigin) throw skip('echo.own_activity', activity.id);
}

/** A Create or Update carries an object its actor wrote, on the actor's own origin. */
export function checkObject(actorApId: string, object: { apId: string; authorApId: string }): void {
  if (originOf(object.apId) !== originOf(actorApId)) {
    throw skip('object.origin_mismatch', `${object.apId} is not on ${originOf(actorApId)}`);
  }
  if (object.authorApId !== actorApId) throw skip('object.author_mismatch', object.authorApId);
}

/** An Undo reverses its own actor's activity (the outer actor of an Undo is the inner one's). */
export function checkUndoActor(undo: Activity, undone: Activity): void {
  if (undo.actorApId !== undone.actorApId) throw skip('embedded.actor_mismatch', `${undone.actorApId} did not undo`);
}

/**
 * Posts, comments and votes are a person's. A community that sends one itself is skipped before
 * anything is built from it (core refuses the same with `post.group_cannot_act` once B1's fix
 * lands; this check keeps a Group-authored row from ever being assembled).
 */
export function checkAuthorIsPerson(ctx: InboundContext): void {
  if (ctx.sender.kind === 'Group') throw skip('actor.group_cannot_act', ctx.sender.apId);
}

/** Before anything is fetched for a community an activity names: an Announce vouches for its own community only. */
export function checkAnnouncer(ctx: InboundContext, communityApId: string): void {
  if (ctx.announce && ctx.announce.community.apId !== communityApId) throw skip('mod.announce_mismatch');
}

type CommunityRef = { id: string; apId: string; local: boolean };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every address a document names: `to`, `cc` and `audience`. */
function addresses(document: unknown): string[] {
  if (!isObject(document)) return [];
  return [...many(document.to), ...many(document.cc), ...many(document.audience)].filter(
    (value): value is string => typeof value === 'string',
  );
}

/**
 * The community an activity claims, read from every addressee rather than the first: its
 * `audience` when it has one, else `community` itself when `to` or `cc` names it anywhere, else
 * the mapping's pick (the first address that is not Public, a followers collection or the
 * actor). Mbin addresses a comment's Delete to the post's author before the community.
 */
export function claimFor(ctx: InboundContext, community: { apId: string }): string | null {
  if (typeof ctx.raw.audience === 'string') return ctx.raw.audience;
  return addresses(ctx.raw).includes(community.apId) ? community.apId : ctx.activity.communityApId;
}

function checkClaim(community: CommunityRef, claimed: string | null): void {
  if (claimed !== null && claimed !== community.apId) throw skip('community.mismatch', `${claimed} is not ${community.apId}`);
}

/**
 * The checks every activity about content in `community` shares: the community it claims is the
 * target's, an Announce is the target community's own, and content in a remote community
 * arrives in that community's Announce or from the community itself.
 */
export function checkCommunity(ctx: InboundContext, community: CommunityRef, claimed: string | null): void {
  checkClaim(community, claimed);
  if (ctx.announce) {
    if (ctx.announce.community.id !== community.id) throw skip('mod.announce_mismatch');
  } else if (!community.local && ctx.sender.id !== community.id) {
    throw skip('community.unannounced', community.apId);
  }
}

/**
 * Who is acting, as core's policies read it: the activity's actor, with the community whose
 * Announce carried it. A community acting for itself (directly or announced) is built the way
 * core's principal refresh expects: announcedBy names that same community.
 */
export function principalOf(ctx: InboundContext): ActingPrincipal {
  const { sender, announce, activity } = ctx;
  if (announce) {
    return { kind: 'remote', actorId: sender.id, announcedBy: { communityId: announce.community.id, announceApId: announce.apId } };
  }
  if (sender.kind === 'Group') {
    return { kind: 'remote', actorId: sender.id, announcedBy: { communityId: sender.id, announceApId: activity.id } };
  }
  return { kind: 'remote', actorId: sender.id, announcedBy: null };
}

/** The grant `action` needs for `subject`, decided inside the transaction; a refusal skips the activity with its exact reason. */
export async function grantFor<A extends ActionName>(ctx: InboundContext, t: Tx, action: A, subject: SubjectOf<A>): Promise<Authorized<A>> {
  const decision = await authorize(action, principalOf(ctx), subject, { db: t.db });
  if (!decision.ok) throw skip(decision.reason);
  return decision.grant;
}

export type Stored = {
  kind: 'post' | 'comment';
  id: string;
  apId: string;
  authorId: string;
  communityId: string;
  postId: string;
  /** The comment this one replies to; null for a post and for a top-level comment. */
  parentId: string | null;
  deleted: boolean;
  removed: boolean;
};

/** A stored post or comment by ap_id, with the community it lives in; null when we hold neither. */
export async function storedContent(q: Queryable, apId: string): Promise<Stored | null> {
  const [post] = await q
    .select({
      id: posts.id,
      apId: posts.apId,
      authorId: posts.authorId,
      communityId: posts.communityId,
      deletedAt: posts.deletedAt,
      removedAt: posts.removedAt,
    })
    .from(posts)
    .where(eq(posts.apId, apId));
  if (post) {
    return {
      kind: 'post',
      id: post.id,
      apId: post.apId,
      authorId: post.authorId,
      communityId: post.communityId,
      postId: post.id,
      parentId: null,
      deleted: post.deletedAt !== null,
      removed: post.removedAt !== null,
    };
  }
  const [comment] = await q
    .select({
      id: comments.id,
      apId: comments.apId,
      authorId: comments.authorId,
      postId: comments.postId,
      parentId: comments.parentId,
      communityId: posts.communityId,
      deletedAt: comments.deletedAt,
      removedAt: comments.removedAt,
    })
    .from(comments)
    .innerJoin(posts, eq(posts.id, comments.postId))
    .where(eq(comments.apId, apId));
  if (!comment) return null;
  return {
    kind: 'comment',
    id: comment.id,
    apId: comment.apId,
    authorId: comment.authorId,
    communityId: comment.communityId,
    postId: comment.postId,
    parentId: comment.parentId,
    deleted: comment.deletedAt !== null,
    removed: comment.removedAt !== null,
  };
}

/** The stored content `apId` names, or a skip that records the missing ap_id for the requeue. */
export async function requireContent(q: Queryable, apId: string): Promise<Stored> {
  const stored = await storedContent(q, apId);
  if (!stored) throw skip('target.missing', apId);
  return stored;
}

const actorColumns = {
  id: actors.id,
  apId: actors.apId,
  name: actors.name,
  kind: actors.kind,
  local: actors.local,
  deletedAt: actors.deletedAt,
  inboxUrl: actors.inboxUrl,
  sharedInboxUrl: actors.sharedInboxUrl,
  instanceId: actors.instanceId,
};

const resolved = ({ deletedAt, ...rest }: { deletedAt: Date | null } & Omit<ResolvedActor, 'deleted'>): ResolvedActor => ({
  ...rest,
  deleted: deletedAt !== null,
});

/** The community actor with this uuid, as the context resolves actors. */
export async function communityById(q: Queryable, id: string): Promise<ResolvedActor> {
  const [row] = await q.select(actorColumns).from(actors).where(eq(actors.id, id));
  if (!row) throw skip('target.missing', id);
  return resolved(row);
}

/** A stored actor by ap_id, as the context resolves actors; null when we hold none. Never fetches. */
export async function storedActor(q: Queryable, apId: string): Promise<ResolvedActor | null> {
  const [row] = await q.select(actorColumns).from(actors).where(eq(actors.apId, apId));
  return row ? resolved(row) : null;
}

/** A community of ours by ap_id, for a Follow or an Undo(Follow): an id on this origin that we hold as a Group. Never fetched. */
export async function localCommunity(ctx: InboundContext, apId: string): Promise<ResolvedActor> {
  const held = new URL(apId).origin === ctx.origin ? await storedActor(db(), apId) : null;
  if (!held || !held.local || held.kind !== 'Group') throw skip('follow.target_unsupported', apId);
  return held;
}

/**
 * The community an activity names, resolved without a fetch: the community whose Announce
 * carried it, the sender when it is the community itself, or one we hold. A community we do not
 * hold cannot have announced anything here, so the activity is `community.unannounced` before
 * any network call (checkCommunity says the same for a held remote community). An Announce
 * vouches for its own community only, checked first.
 */
export async function claimedCommunity(ctx: InboundContext, apId: string): Promise<ResolvedActor> {
  checkAnnouncer(ctx, apId);
  if (ctx.announce) return ctx.announce.community;
  if (ctx.sender.apId === apId) return ctx.sender;
  const held = await storedActor(db(), apId);
  if (!held) throw skip('community.unannounced', apId);
  return held;
}

/**
 * A report counts only about content stored here, in a community hosted here: reports go to
 * the moderators of the hosting instance (the spike's N8). Reports about people are not read yet.
 */
export async function authorizeReport(q: Queryable, targetApIds: readonly string[]): Promise<void> {
  const found = targetApIds.length === 0 ? [] : await Promise.all(targetApIds.map((apId) => storedContent(q, apId)));
  const content = found.filter((item): item is Stored => item !== null);
  if (content.length === 0) throw skip('report.not_local', targetApIds[0]);
  const hosted = await q
    .select({ id: actors.id })
    .from(actors)
    .where(
      and(
        eq(actors.local, true),
        inArray(
          actors.id,
          content.map((item) => item.communityId),
        ),
      ),
    );
  if (hosted.length !== new Set(content.map((item) => item.communityId)).size) throw skip('report.not_local', content[0]?.apId);
}
