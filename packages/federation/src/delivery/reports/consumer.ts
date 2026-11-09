import type { Queryable } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { reports } from '@peblish/core/db/tables/moderation';
import { defineConsumer } from '@peblish/core/outbox/consumers';
import type { ContentRef } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { enqueueDeliveries } from '../queue.ts';
import { actorRefs, type ActorRef } from '../records.ts';
import { flagDocument, isCategory } from './flag.ts';

// Sends a local report to the people it concerns, when the reporter asked for it (`forward`):
// the moderators of the remote community, through its shared inbox when it has one, and the
// remote author's instance, as Lemmy sends its own reports (`Report::send`). The Flag is signed
// as the reporter and queued for delivery directly. It is never stored in `activities`: that
// table is served by id, and a Flag names its reporter and their reason. A report that stays
// here (admins-only categories, a person or community, no remote recipient) never gets this far:
// the policy refused `forward` for it.

type Held = { apId: string; authorId: string; communityId: string };

async function heldContent(db: Queryable, target: ContentRef): Promise<Held | null> {
  const [row] =
    target.kind === 'post'
      ? await db
          .select({ apId: posts.apId, authorId: posts.authorId, communityId: posts.communityId })
          .from(posts)
          .where(eq(posts.id, target.id))
      : await db
          .select({ apId: comments.apId, authorId: comments.authorId, communityId: posts.communityId })
          .from(comments)
          .innerJoin(posts, eq(posts.id, comments.postId))
          .where(eq(comments.id, target.id));
  return row ?? null;
}

const inboxOf = (actor: ActorRef) => actor.sharedInboxUrl ?? actor.inboxUrl;

/** The remote community's inbox and, when it is on another host, the remote author's. */
function recipients(community: ActorRef, author: ActorRef): string[] {
  const inboxes: string[] = [];
  const communityInbox = community.local ? null : inboxOf(community);
  if (communityInbox) inboxes.push(communityInbox);
  const authorInbox = author.local ? null : inboxOf(author);
  if (authorInbox && (!communityInbox || new URL(authorInbox).host !== new URL(communityInbox).host)) inboxes.push(authorInbox);
  return inboxes;
}

export const consumer = defineConsumer({
  name: 'federation.reports',
  events: ['report.created'],
  startAt: 'beginning',
  async handle(event, t) {
    if (!event.local || !event.forward || !event.apId || event.target.kind === 'actor' || !event.reporterId) return;
    const [report] = await t.db.select().from(reports).where(eq(reports.id, event.reportId));
    if (!report || !isCategory(report.category)) return;
    const content = await heldContent(t.db, event.target);
    if (!content) return;
    const refs = await actorRefs(t.db, [event.reporterId, content.authorId, content.communityId]);
    const reporter = refs.get(event.reporterId);
    const author = refs.get(content.authorId);
    const community = refs.get(content.communityId);
    // A reporter who deleted their account since cannot sign; the report stays on the instance.
    if (!reporter || reporter.deleted || !author || !community) return;
    const inboxes = recipients(community, author);
    if (inboxes.length === 0) return;
    const body = JSON.stringify(
      flagDocument({
        id: event.apId,
        reporterApId: reporter.apId,
        communityApId: community.apId,
        targetApId: content.apId,
        category: report.category,
        details: report.reason,
      }),
    );
    await enqueueDeliveries(t, { activityApId: event.apId, senderId: reporter.id, body, inboxes });
  },
});
