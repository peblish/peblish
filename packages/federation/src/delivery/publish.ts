import type { OpenTx } from '@peblish/core/tx/tx';
import type { Json } from '../mapping/json.ts';
import type { Activity, ContentObject, PostRecord } from '../mapping/records.ts';
import { announce } from './activities.ts';
import { followerInboxes } from './followers.ts';
import { newActivityId, sendActivity, storeActivity } from './send.ts';
import type { ActorRef, Mentioned } from './records.ts';
import { withdrawBoosts } from './withdraw.ts';

// Publishing what a local actor did in a community. Storing and queueing live in send.ts and
// are re-exported here for the lanes that import them from this file.
export { newActivityId, sendActivity, storeActivity, type StoredActivity } from './send.ts';

export type CommunityContext = { origin: string; author: ActorRef; community: ActorRef };

export type PublishOptions = {
  /** A new post: Mastodon-like followers get Announce(Page) (they ignore Announce(Create(Page))). */
  page?: PostRecord;
  /** Mention objects for the post or comment `inner` carries. */
  tags?: readonly Json[];
  /** The remote people the body names: addressed in `cc`, and sent `inner` directly when no Announce reaches them. */
  mentions?: readonly Mentioned[];
  /**
   * The remote people an earlier copy was addressed to (records.ts `mentionedBefore`): sent
   * `inner` directly when nothing else reaches their inbox, as `mentions` are, but not put in
   * `cc` (an edit that drops a mention no longer names them).
   */
  earlier?: readonly Mentioned[];
  /**
   * What Mastodon-like followers get besides the new-post Announce(Page); by default nothing, as
   * Mastodon drops what an Announce wraps. `'inner'` sends `inner` itself, signed by the author
   * (an edit: Update(Page)). `{ withdraw }` takes the boosts of that post back (withdraw.ts).
   */
  microblog?: 'inner' | { withdraw: string };
};

/**
 * Publishes an activity a local actor did in a community.
 *
 * - In a remote community the author's activity goes to the community's inbox, and the
 *   community announces it to its followers.
 * - In a local community the activity is stored (it is served at its id and listed in the
 *   outbox) and the community announces it to each threadiverse follower inbox, and to
 *   anything unknown, as Announce(activity). A Mastodon-like inbox is sent only a new post
 *   (Announce(Page)) and what `options.microblog` asks for, never an Announce of anything else.
 * - A remote person the body mentions, or an earlier copy was addressed to, gets `inner`
 *   directly when none of the above reaches their inbox.
 */
export async function publishInCommunity(
  t: OpenTx,
  { origin, author, community }: CommunityContext,
  inner: Activity,
  options: PublishOptions = {},
): Promise<void> {
  const tags = options.tags ?? [];
  const mentions = options.mentions ?? [];
  const cc = mentions.map(({ apId }) => apId);
  const named = [...mentions, ...(options.earlier ?? [])].map(({ inbox }) => inbox);
  if (!community.local) {
    if (!community.inboxUrl) return;
    const direct = named.filter((inbox) => inbox !== community.inboxUrl);
    await sendActivity(t, author, inner, [...new Set([community.inboxUrl, ...direct])], tags, cc);
    return;
  }
  await storeActivity(t, inner, tags, cc);
  const targets = await followerInboxes(t.db, community.id);
  const announceTo = async (object: Activity | ContentObject, inboxes: readonly string[]) =>
    sendActivity(
      t,
      community,
      announce({ id: newActivityId(origin), actorApId: community.apId, communityApId: community.apId }, object),
      inboxes,
      tags,
      cc,
    );
  await announceTo(inner, targets.create);
  if (options.page) await announceTo({ type: 'Page', post: options.page }, targets.page);
  const { microblog } = options;
  const reached = new Set([...targets.create, ...(options.page || microblog === 'inner' ? targets.page : [])]);
  const direct = [...(microblog === 'inner' ? targets.page : []), ...named.filter((inbox) => !reached.has(inbox))];
  await sendActivity(t, author, inner, [...new Set(direct)], tags, cc);
  if (typeof microblog === 'object') await withdrawBoosts(t, { origin, community, postApId: microblog.withdraw, announced: inner });
}
