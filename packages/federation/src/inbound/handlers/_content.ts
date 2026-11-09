import { db } from '@peblish/core/db/read';
import { posts } from '@peblish/core/db/tables/content';
import { storeRemoteComment, updateRemoteComment } from '@peblish/core/comments/remote';
import { storeRemotePost, updateRemotePost } from '@peblish/core/posts/remote';
import { eq } from 'drizzle-orm';
import type { CommentRecord, ContentObject, PostRecord } from '../../mapping/records.ts';
import {
  checkAnnouncer,
  checkAuthorIsPerson,
  checkCommunity,
  checkObject,
  communityById,
  grantFor,
  requireContent,
  storedContent,
} from '../authorize.ts';
import { prepared, type InboundContext, type Prepared } from '../handler.ts';
import { skip } from '../reasons.ts';

// Create and Update of a Page (a post) or a Note (a comment), which differ only in the verb:
// an Update for an object we never saw is stored like a Create, as Lemmy does.

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The community the object says it belongs to, when it says so in `audience`; the claim a comment is checked against. */
const audienceOf = (ctx: InboundContext): string | null => {
  const object = ctx.raw.object;
  return isObject(object) && typeof object.audience === 'string' ? object.audience : null;
};

async function preparePage(ctx: InboundContext, post: PostRecord, verb: 'Create' | 'Update'): Promise<Prepared> {
  checkAuthorIsPerson(ctx);
  checkObject(ctx.activity.actorApId, post);
  checkAnnouncer(ctx, post.communityApId);
  const community = await ctx.actor(post.communityApId);
  if (community.kind !== 'Group') throw skip('community.mismatch', post.communityApId);
  checkCommunity(ctx, community, null);
  return prepared(ctx, async (t) => {
    const [existing] = await t.db.select({ id: posts.id }).from(posts).where(eq(posts.apId, post.apId));
    if (existing && verb === 'Update') {
      const grant = await grantFor(ctx, t, 'post.update', { postId: existing.id });
      await updateRemotePost.within(t, grant, post);
      return { communityId: community.id, objectApId: post.apId, relay: true };
    }
    const grant = await grantFor(ctx, t, 'post.create', { communityId: community.id });
    if (post.sensitive || post.nsfl) throw skip('content.nsfw_rejected', post.apId);
    const stored = await storeRemotePost.within(t, grant, post);
    if (!stored.created) throw skip('object.exists', post.apId);
    return {
      communityId: community.id,
      objectApId: post.apId,
      stored: [post.apId],
      page: verb === 'Create' ? post : undefined,
      relay: true,
    };
  });
}

async function prepareNote(ctx: InboundContext, comment: CommentRecord, verb: 'Create' | 'Update'): Promise<Prepared> {
  checkAuthorIsPerson(ctx);
  checkObject(ctx.activity.actorApId, comment);
  const parent = await requireContent(db(), comment.inReplyToApId);
  const community = await communityById(db(), parent.communityId);
  checkCommunity(ctx, community, audienceOf(ctx));
  return prepared(ctx, async (t) => {
    const existing = await storedContent(t.db, comment.apId);
    if (existing && verb === 'Update') {
      const grant = await grantFor(ctx, t, 'comment.update', { commentId: existing.id });
      await updateRemoteComment.within(t, grant, comment);
      return { communityId: community.id, objectApId: comment.apId, relay: true };
    }
    if (existing) throw skip('object.exists', comment.apId);
    const grant = await grantFor(ctx, t, 'comment.create', {
      postId: parent.postId,
      parentId: parent.kind === 'comment' ? parent.id : null,
    });
    const stored = await storeRemoteComment.within(t, grant, comment);
    if (!stored.created) throw skip('object.exists', comment.apId);
    return { communityId: community.id, objectApId: comment.apId, stored: [comment.apId], relay: true };
  });
}

/** Create or Update of content: the object is a Page or a Note (the classifier refused the rest). */
export function prepareContent(ctx: InboundContext, object: ContentObject, verb: 'Create' | 'Update'): Promise<Prepared> {
  return object.type === 'Page' ? preparePage(ctx, object.post, verb) : prepareNote(ctx, object.comment, verb);
}
