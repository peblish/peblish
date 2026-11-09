import type { OpenTx } from '@peblish/core/tx/tx';
import type { Json } from '../mapping/json.ts';
import type { Activity, ContentObject, PostRecord } from '../mapping/records.ts';
import { announce } from './activities.ts';
import { followerInboxes } from './followers.ts';
import { newActivityId, sendActivity, storeActivity } from './send.ts';
import type { ActorRef } from './records.ts';
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
 */
export async function publishInCommunity(
  t: OpenTx,
  { origin, author, community }: CommunityContext,
  inner: Activity,
  options: PublishOptions = {},
): Promise<void> {
  const tags = options.tags ?? [];
  if (!community.local) {
    if (!community.inboxUrl) return;
    await sendActivity(t, author, inner, [community.inboxUrl], tags);
    return;
  }
  await storeActivity(t, inner, tags);
  const targets = await followerInboxes(t.db, community.id);
  const announceTo = async (object: Activity | ContentObject, inboxes: readonly string[]) =>
    sendActivity(
      t,
      community,
      announce({ id: newActivityId(origin), actorApId: community.apId, communityApId: community.apId }, object),
      inboxes,
      tags,
    );
  await announceTo(inner, targets.create);
  if (options.page) await announceTo({ type: 'Page', post: options.page }, targets.page);
  const { microblog } = options;
  if (microblog === 'inner') await sendActivity(t, author, inner, targets.page, tags);
  if (typeof microblog === 'object') await withdrawBoosts(t, { origin, community, postApId: microblog.withdraw, announced: inner });
}
