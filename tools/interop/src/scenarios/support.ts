// What the content scenarios share: both directions of following, ready before they start, and
// waits for a post or comment to show on a peer.
import type { Uuid } from '@peblish/schema/ids';
import type { Context } from '../context.ts';
import { waitFor } from '../lab.ts';
import { matchInbound } from '../match.ts';
import { followRow, peblish, sql } from '../peblish.ts';
import type { Peer, PeerComment, PeerPost } from '../peers/types.ts';

export type Side = {
  peer: Peer;
  /** The peer's ordinary user. */
  token: string;
  /** The peer's admin (owns the peer's community). */
  adminToken: string;
  /** peblish's `!lab` as the peer knows it. */
  labOnPeer: number;
  /** The peer's community as peblish knows it, followed by alice. */
  remote: { id: Uuid; apId: string; handle: string };
  /** The peer's own community (`!lab@lemmy.lab.test`) on the peer. */
  peerCommunityId: number;
};

/**
 * Makes both follows true, in whatever state the lab is in: the peer's user follows peblish's
 * `!lab` and alice follows the peer's community. F1 and F2 prove how they come about; the groups
 * after them only need them to hold, so a group can run on its own (`make interop ONLY=P1`).
 */
export async function prepare(ctx: Context, peer: Peer): Promise<Side> {
  const token = await peer.login(peer.user);
  const adminToken = await peer.login(peer.admin);
  const onPeer = await peer.resolveCommunity(token, ctx.community.handle);
  if (onPeer.subscribed === 'NotSubscribed') await peer.follow(token, onPeer.id);
  await waitFor(
    `${peer.name} to follow ${ctx.community.handle}`,
    async () => (await peer.resolveCommunity(token, ctx.community.handle)).subscribed === 'Subscribed',
    { timeoutMs: 60_000 },
  );
  // A second follower: Lemmy drops a banned user's subscription and then refuses the community's
  // Announces while nobody there follows it (CommunityHasNoFollowers), which would swallow the unban.
  const adminView = await peer.resolveCommunity(adminToken, ctx.community.handle);
  if (adminView.subscribed === 'NotSubscribed') await peer.follow(adminToken, adminView.id);
  const handle = peer.communityHandle();
  const resolved = await peblish.resolve(handle);
  const remoteId = resolved.id as Uuid;
  if ((await followRow('alice', remoteId))?.state !== 'accepted') {
    if (!(await followRow('alice', remoteId))) await peblish.followRemote('alice', handle);
    await waitFor(`alice to follow ${handle}`, async () => (await followRow('alice', remoteId))?.state === 'accepted', {
      timeoutMs: 90_000,
    });
  }
  const peerCommunity = await peer.resolveCommunity(token, handle);
  return {
    peer,
    token,
    adminToken,
    labOnPeer: onPeer.id,
    remote: { id: remoteId, apId: resolved.apId, handle },
    peerCommunityId: peerCommunity.id,
  };
}

/** The post as the peer lists it in a community, once it has arrived. */
export function postOnPeer(side: Side, communityId: number, apId: string, { timeoutMs = 45_000 } = {}): Promise<PeerPost> {
  return waitFor(
    `${side.peer.name} to list ${apId}`,
    async () => (await side.peer.listPosts(side.token, communityId)).find((post) => post.apId === apId),
    { timeoutMs },
  );
}

export function commentOnPeer(side: Side, peerPostId: number, apId: string, { timeoutMs = 45_000 } = {}): Promise<PeerComment> {
  return waitFor(
    `${side.peer.name} to list comment ${apId}`,
    async () => (await side.peer.listComments(side.token, peerPostId)).find((comment) => comment.apId === apId),
    { timeoutMs },
  );
}

/** A post's row in peblish by ap_id, once stored. */
export async function storedPost(ctx: Context, apId: string, timeoutMs = 45_000) {
  return waitFor(
    `peblish to store ${apId}`,
    async () => {
      const rows = await ctx.sql<{ id: Uuid; title: string; body_md: string | null; url: string | null; deleted_at: Date | null }[]>`
        select id, title, body_md, url, deleted_at from posts where ap_id = ${apId}`;
      return rows[0];
    },
    { timeoutMs },
  );
}

export async function storedComment(ctx: Context, apId: string) {
  return waitFor(
    `peblish to store comment ${apId}`,
    async () => {
      const rows = await ctx.sql<{ id: Uuid; body_md: string | null; parent_id: Uuid | null; post_id: Uuid; deleted_at: Date | null }[]>`
        select id, body_md, parent_id, post_id, deleted_at from comments where ap_id = ${apId}`;
      return rows[0];
    },
    { timeoutMs: 45_000 },
  );
}

/** Text shared by a title and a body, so a post is easy to find in a log. */
export const tag = (ctx: Context, label: string, who: { name: string }) => `${label} ${who.name} ${ctx.run}`;

/**
 * The post a peer's admin makes in the peer's own community, as peblish stores it. When peblish
 * does not store it, the error says what peblish did with the activity instead: the matcher's
 * `got [...]` outcome, so a scenario can name the defect exactly.
 */
export async function peerOwnPostInPeblish(ctx: Context, side: Side, title: string, by: 'admin' | 'user' = 'admin') {
  const { peer } = side;
  const started = new Date();
  const token = by === 'admin' ? side.adminToken : side.token;
  const post = await peer.createPost(token, side.peerCommunityId, title, `The ${peer.name} community starts this one.`);
  ctx.ledger.add({
    kind: 'object',
    side: peer.name,
    user: by === 'admin' ? peer.admin : peer.user,
    type: 'post',
    apId: post.apId,
    peerId: post.id,
  });
  try {
    const stored = await storedPost(ctx, post.apId, 25_000);
    return { post, stored };
  } catch {
    const rows = await sql()<
      {
        id: string;
        activity_id: string | null;
        activity_type: string | null;
        actor_ap_id: string | null;
        state: string;
        error: string | null;
      }[]
    >`
      select id, activity_id, activity_type, actor_ap_id, state, error from inbox_raw
      where received_at >= ${started} and position(${title} in convert_from(body, 'UTF8')) > 0 order by received_at`;
    const query = { since: started, contains: title };
    matchInbound(
      rows.map((r) => ({
        id: r.id,
        activityId: r.activity_id,
        type: r.activity_type,
        actor: r.actor_ap_id,
        state: r.state,
        error: r.error,
      })),
      query,
      { state: 'applied' },
    );
    throw new Error(`peblish applied the activity for ${post.apId} but stored no post`);
  }
}
