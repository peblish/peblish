// Driving peblish without a control surface. The runner is a container on the lab network with
// the same database and BETTER_AUTH_SECRET as peblish-web, and a user's action is what the web
// process would call: authorize, then the mutation, as `{ kind: 'local', actorId, siteRole }`.
// Peers reach the real inbox over HTTP, and only the worker delivers: the runner starts no
// consumer and no job, so what it sends is exactly what peblish-worker sends.
import { authorize } from '@peblish/core/authz/authorize';
import type { ActionName, SubjectOf } from '@peblish/core/authz/policy';
import { createCommentAs, deleteCommentAs, updateCommentAs } from '@peblish/core/comments/actions';
import { createCommunityAs } from '@peblish/core/communities/create';
import { setModeratorAs } from '@peblish/core/communities/moderators';
import { updateCommunityAs } from '@peblish/core/communities/update';
import { closePools } from '@peblish/core/db/pools';
import { removeFollow, requestFollow } from '@peblish/core/follows/follow';
import { deleteAccountAs } from '@peblish/core/identity/delete';
import { banFromCommunity, unbanFromCommunity } from '@peblish/core/moderation/ban';
import { lockPost, unlockPost } from '@peblish/core/moderation/lock';
import { pinPost, unpinPost } from '@peblish/core/moderation/pin';
import { removeContent, restoreContent } from '@peblish/core/moderation/remove';
import { createPostAs, deletePostAs, updatePostAs } from '@peblish/core/posts/actions';
import { createReportAs } from '@peblish/core/reports/actions';
import type { ReportCategory } from '@peblish/core/reports/categories';
import { siteBanAs, siteUnbanAs } from '@peblish/core/bans/service';
import { voteAs } from '@peblish/core/votes/service';
import { resolveRemoteActor } from '@peblish/federation/actors/resolve';
import { mirrorNow } from '@peblish/federation/inbound/moderators/refresh';
import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import postgres from 'postgres';
import type { Sql } from './match.ts';

type Local = Extract<Principal, { kind: 'local' }>;

let connection: Sql | undefined;

/** The runner's own connection, for reading peblish's tables (the matcher, the ledger). */
export function sql(): Sql {
  connection ??= postgres(process.env.DATABASE_URL ?? '', { max: 4, onnotice: () => undefined });
  return connection;
}

/** Closes core's pools and the runner's connection; call once at the end of a process. */
export async function closeAll(): Promise<void> {
  await closePools();
  await connection?.end({ timeout: 5 });
  connection = undefined;
}

export class Refused extends Error {
  override readonly name = 'Refused';
  readonly reason: string;
  constructor(action: string, reason: string) {
    super(`${action} refused: ${reason}`);
    this.reason = reason;
  }
}

/** Unwraps a `Result` from a `*As` wrapper: a refusal is an error naming the closed reason. */
function value<T>(action: string, result: ({ ok: true } & T) | { ok: false; reason: string }): T {
  if (!result.ok) throw new Refused(action, result.reason);
  return result;
}

const principals = new Map<string, Local>();

/** The local principal for an account, found by actor name. */
export async function as(name: string): Promise<Local> {
  const cached = principals.get(name);
  if (cached) return cached;
  const [row] = await sql()<{ id: Uuid; role: string | null; two_factor: boolean | null }[]>`
    select a.id, u.role, u.two_factor_enabled as two_factor from actors a
    left join auth_user u on u.id = a.user_id where a.local and a.kind = 'Person' and a.name = ${name}`;
  if (!row) throw new Error(`no local account ${name}`);
  const principal: Local = { kind: 'local', actorId: row.id, siteRole: row.role === 'admin' && row.two_factor ? 'admin' : 'user' };
  principals.set(name, principal);
  return principal;
}

/** Forgets a cached principal (after two-factor is turned on for the account). */
export const forget = (name: string) => principals.delete(name);

async function grant<A extends ActionName>(action: A, who: Principal, subject: SubjectOf<A>) {
  const decision = await authorize(action, who, subject);
  if (!decision.ok) throw new Refused(action, decision.reason);
  return decision.grant;
}

// ------------------------------------------------------------------ lookups

/** A local actor's id by kind and name. */
export async function localActorId(kind: 'Person' | 'Group', name: string): Promise<Uuid> {
  const [row] = await sql()<{ id: Uuid }[]>`select id from actors where local and kind = ${kind} and name = ${name}`;
  if (!row) throw new Error(`no local ${kind} ${name}`);
  return row.id;
}

/** Any actor's id by ap_id. */
export async function actorIdByApId(apId: string): Promise<Uuid> {
  const [row] = await sql()<{ id: Uuid }[]>`select id from actors where ap_id = ${apId}`;
  if (!row) throw new Error(`no actor ${apId}`);
  return row.id;
}

/** A stored post's id and author-facing fields by ap_id; null when peblish does not hold it. */
export async function postByApId(apId: string) {
  const [row] = await sql()<
    {
      id: Uuid;
      title: string;
      body_md: string | null;
      url: string | null;
      deleted_at: Date | null;
      removed_at: Date | null;
      locked: boolean;
      featured_community: boolean;
      author_id: Uuid;
      community_id: Uuid;
    }[]
  >`select id, title, body_md, url, deleted_at, removed_at, locked, featured_community, author_id, community_id from posts where ap_id = ${apId}`;
  return row ?? null;
}

export async function commentByApId(apId: string) {
  const [row] = await sql()<
    {
      id: Uuid;
      body_md: string | null;
      deleted_at: Date | null;
      removed_at: Date | null;
      post_id: Uuid;
      parent_id: Uuid | null;
      author_id: Uuid;
    }[]
  >`
    select id, body_md, deleted_at, removed_at, post_id, parent_id, author_id from comments where ap_id = ${apId}`;
  return row ?? null;
}

export async function apIdOf(table: 'posts' | 'comments' | 'actors', id: Uuid): Promise<string> {
  const [row] = await sql()<{ ap_id: string }[]>`select ap_id from ${sql()(table)} where id = ${id}`;
  if (!row) throw new Error(`no ${table} row ${id}`);
  return row.ap_id;
}

export type Followed = { state: 'pending' | 'accepted'; apId: string | null } | null;

export async function followRow(followerName: string, communityId: Uuid): Promise<Followed> {
  const follower = await localActorId('Person', followerName);
  const [row] = await sql()<{ state: 'pending' | 'accepted'; ap_id: string | null }[]>`
    select state, ap_id from follows where follower_id = ${follower} and followee_id = ${communityId}`;
  return row ? { state: row.state, apId: row.ap_id } : null;
}

// ------------------------------------------------------------------ actions

export const peblish = {
  async createCommunity(admin: string, name: string, title: string, description?: string) {
    return value(
      'community.create',
      await createCommunityAs(await as(admin), { name, displayName: title, ...(description ? { description } : {}) }),
    );
  },
  async updateCommunity(who: string, communityId: Uuid, patch: { displayName?: string; description?: string | null }) {
    value('community.update', await updateCommunityAs(await as(who), communityId, patch));
  },
  async createPost(who: string, communityId: Uuid, input: { title: string; bodyMd?: string; url?: string }) {
    return value('post.create', await createPostAs(await as(who), communityId, input));
  },
  async editPost(who: string, postId: Uuid, edit: { title?: string; bodyMd?: string }) {
    value('post.update', await updatePostAs(await as(who), postId, edit));
  },
  async deletePost(who: string, postId: Uuid) {
    value('post.delete', await deletePostAs(await as(who), postId));
  },
  async comment(who: string, where: { postId: Uuid; parentId?: Uuid | null }, bodyMd: string) {
    return value(
      'comment.create',
      await createCommentAs(await as(who), { postId: where.postId, parentId: where.parentId ?? null }, { bodyMd }),
    );
  },
  async editComment(who: string, commentId: Uuid, bodyMd: string) {
    value('comment.update', await updateCommentAs(await as(who), commentId, { bodyMd }));
  },
  async deleteComment(who: string, commentId: Uuid) {
    value('comment.delete', await deleteCommentAs(await as(who), commentId));
  },
  async vote(who: string, target: { kind: 'post' | 'comment'; id: Uuid }, score: -1 | 0 | 1) {
    return value('vote.cast', await voteAs(await as(who), target, score));
  },
  /** Stores the remote community (`!name@host`) and sends a Follow through the worker. */
  async followRemote(who: string, handle: string) {
    const community = await resolveRemoteActor(handle);
    const result = await requestFollow(await grant('follow.request', await as(who), { communityId: community.id as Uuid }));
    return { communityId: community.id as Uuid, apId: community.apId, ...result };
  },
  async unfollow(who: string, communityId: Uuid) {
    const me = await as(who);
    const row = await followRow(who, communityId);
    if (!row) throw new Error(`${who} does not follow ${communityId}`);
    return removeFollow(await grant('follow.remove', me, { followerId: me.actorId, followeeId: communityId, apId: row.apId }));
  },
  async lock(who: string, postId: Uuid, locked: boolean, reason = 'lab') {
    const me = await as(who);
    return locked
      ? lockPost(await grant('mod.lock', me, { postId }), { reason })
      : unlockPost(await grant('mod.unlock', me, { postId }), { reason });
  },
  async pin(who: string, postId: Uuid, pinned: boolean) {
    const me = await as(who);
    return pinned ? pinPost(await grant('mod.pin', me, { postId }), {}) : unpinPost(await grant('mod.unpin', me, { postId }), {});
  },
  async removePost(who: string, postId: Uuid, reason = 'lab') {
    const me = await as(who);
    return removeContent(await grant('mod.remove', me, { target: { kind: 'post', id: postId } }), { reason });
  },
  async restorePost(who: string, postId: Uuid, reason = 'lab') {
    const me = await as(who);
    return restoreContent(await grant('mod.restore', me, { target: { kind: 'post', id: postId } }), { reason });
  },
  async ban(who: string, communityId: Uuid, targetActorId: Uuid, reason = 'lab', removeContentToo = false) {
    return banFromCommunity(await grant('mod.ban', await as(who), { communityId, targetActorId }), {
      reason,
      removeContent: removeContentToo,
    });
  },
  async unban(who: string, communityId: Uuid, targetActorId: Uuid, reason = 'lab') {
    return unbanFromCommunity(await grant('mod.unban', await as(who), { communityId, targetActorId }), { reason });
  },
  /** An instance-wide ban by a local admin; federates as a Block of the person with the instance as target. */
  async siteBan(who: string, targetActorId: Uuid, reason = 'lab', removeContentToo = false) {
    return value('mod.site_ban', await siteBanAs(await as(who), targetActorId, { reason, removeContent: removeContentToo }));
  },
  async siteUnban(who: string, targetActorId: Uuid, reason = 'lab') {
    return value('mod.site_unban', await siteUnbanAs(await as(who), targetActorId, { reason }));
  },
  /** A report of a post, sent on to the hosts concerned when `forward` is set (a Flag, signed as the reporter). */
  async reportPost(who: string, postId: Uuid, category: ReportCategory, details: string, forward = true) {
    return value(
      'report.create',
      await createReportAs(await as(who), { target: { kind: 'post', id: postId }, category, forward, details }),
    );
  },
  async setModerator(who: string, communityId: Uuid, actorId: Uuid, role: 'owner' | 'moderator' | null) {
    return value('community.set_moderator', await setModeratorAs(await as(who), { communityId, actorId, role }));
  },
  async deleteAccount(who: string) {
    const me = await as(who);
    value('account.delete', await deleteAccountAs(me, me.actorId, 'lab'));
  },
  /** Reads a remote community's moderators now (the 15 minute job is too slow for a scenario). */
  mirrorModerators: (communityId: Uuid) => mirrorNow(communityId),
  resolve: (target: string, options?: { refresh?: boolean }) => resolveRemoteActor(target, options),
  removeContent,
};
