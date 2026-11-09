import { randomUUID } from 'node:crypto';
import { commentingDenial } from '@peblish/core/authz/state';
import { comments as commentsTable } from '@peblish/core/db/tables/content';
import { eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { PUBLIC } from '../mapping/vocabulary.ts';
import { comments } from './comments.ts';
import { skip } from './reasons.ts';

// Test support for the inbound pipeline (never imported by product code).

export { PUBLIC };

export const hosts = {
  spike: 'https://fed-b.test/ap/c.spike',
  lab: 'https://lemmy.test/c/lab',
  lemmyuser: 'https://lemmy.test/u/lemmyuser',
  lemmyadmin: 'https://lemmy.test/u/lemmyadmin',
  pfuser: 'https://piefed.test/u/pfuser',
  mallory: 'https://rogue.test/u/mallory',
  fake: 'https://rogue.test/c/fake',
  t1: 'https://lemmy.test/post/1',
  t2: 'https://lemmy.test/post/2',
} as const;

/** A fresh activity id on `origin`. */
export const activityId = (origin: string, type: string) => `${origin}/activities/${type.toLowerCase()}/${randomUUID()}`;

export const addressedToCommunity = (community: string) => ({ to: [PUBLIC], cc: [community], audience: community });

/**
 * Stands in for lane D's comment mutations until root wires them (inbound/comments.ts): the
 * real guard core ships for comment.create (commentingDenial), then a plain insert. It checks
 * the pipeline's wiring (who is the principal, which post, the exact refusal), not D's code.
 */
export function useCommentDouble() {
  const created = vi.spyOn(comments, 'create').mockImplementation(async (ctx, t, comment, parent) => {
    const denial = await commentingDenial({ db: t.db, lock: true }, ctx.sender.id, {
      postId: parent.postId,
      parentId: parent.kind === 'comment' ? parent.id : null,
    });
    if (denial) throw skip(denial.reason);
    const id = randomUUID();
    await t.db.insert(commentsTable).values({
      id,
      apId: comment.apId,
      local: false,
      instanceId: ctx.sender.instanceId,
      postId: parent.postId,
      authorId: ctx.sender.id,
      parentId: parent.kind === 'comment' ? parent.id : null,
      path: id.replaceAll('-', '_'),
      bodyMd: comment.bodyMd,
      contentHtml: comment.contentHtml,
      publishedAt: comment.publishedAt ?? new Date(),
    });
    return { created: true };
  });
  vi.spyOn(comments, 'update').mockImplementation(async (_ctx, t, comment, existing) => {
    await t.db
      .update(commentsTable)
      .set({ bodyMd: comment.bodyMd, contentHtml: comment.contentHtml, editedAt: new Date() })
      .where(eq(commentsTable.id, existing.id));
  });
  vi.spyOn(comments, 'delete').mockImplementation(async (_ctx, t, existing) => {
    if (existing.deleted) throw skip('target.deleted');
    await t.db.update(commentsTable).set({ deletedAt: new Date() }).where(eq(commentsTable.id, existing.id));
  });
  return created;
}
