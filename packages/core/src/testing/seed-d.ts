import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { threadPageSize } from '../comments/limits.ts';
import { removeContent } from '../moderation/remove.ts';
import { grantFor, seedModerator, seedPost } from './seed-az.ts';
import { seedPostWorld } from './seed-b1.ts';
import { seedActor } from './seed.ts';

// Lane D's seeds: comment threads of any shape, the world of the comment policy table, and
// what e2e/comments runs against. Test code only.

type Instance = { id: string; domain: string; local: boolean };
type Row = { id: string };
export type Parent = { id: string; path: string };

const past = () => new Date(Date.now() - 60_000);

/**
 * A comment under `parent` (top level when null), with its path built and the counts kept as
 * createComment does: the post's comment_count, and child_count on every ancestor.
 */
export async function seedReply(
  instance: Instance,
  post: Row,
  parent: Parent | null,
  author: Row,
  extra: Partial<typeof comments.$inferInsert> = {},
): Promise<Parent & { id: string }> {
  const id = uuidv7();
  const path = parent ? `${parent.path}.${id}` : id;
  await writer()
    .insert(comments)
    .values({
      id,
      apId: `https://${instance.domain}/ap/comment/${id}`,
      local: instance.local,
      instanceId: instance.id,
      postId: post.id,
      parentId: parent?.id ?? null,
      authorId: author.id,
      path,
      bodyMd: `Comment ${id}`,
      publishedAt: new Date(),
      ...extra,
    });
  await writer()
    .update(posts)
    .set({ commentCount: sql`${posts.commentCount} + 1` })
    .where(eq(posts.id, post.id));
  if (parent) {
    await writer()
      .update(comments)
      .set({ childCount: sql`${comments.childCount} + 1` })
      .where(sql`${comments.path} @> ${parent.path}::ltree`);
  }
  return { id, path };
}

/** Sets every count of the post's thread from its rows, for a thread seeded in bulk. */
export async function recount(postId: string): Promise<void> {
  await writer().transaction(async (t) => {
    await t.execute(
      sql`update ${comments} c set child_count = (select count(*) from ${comments} k where k.path <@ c.path and k.id <> c.id) where c.post_id = ${postId}`,
    );
    await t
      .update(posts)
      .set({ commentCount: sql`(select count(*) from ${comments} where ${comments.postId} = ${postId})` })
      .where(eq(posts.id, postId));
  });
}

/** A chain of replies, each under the last, `depth` levels deep; returns every comment, top first. */
export async function seedChain(instance: Instance, post: Row, author: Row, depth: number): Promise<Parent[]> {
  const chain: Parent[] = [];
  for (let level = 1; level <= depth; level++) chain.push(await seedReply(instance, post, chain.at(-1) ?? null, author));
  return chain;
}

/**
 * A big thread in a few bulk inserts: a chain down to `depth` levels, then comments under
 * randomly chosen earlier ones (a fixed seed, so every run has the same shape) until the thread
 * has `size` comments. Scores and times vary. Counts are set at the end.
 */
export async function seedBigThread(instance: Instance, post: Row, authors: readonly Row[], size: number, depth: number) {
  let state = 12345;
  // Park and Miller's generator: the products stay exact in a double.
  const next = (bound: number) => ((state = (state * 48271) % 2147483647), state % bound);
  const start = Date.now() - size * 60_000;
  const made: (typeof comments.$inferInsert & { id: string; path: string; level: number })[] = [];
  const add = (parent: (typeof made)[number] | null) => {
    const id = uuidv7();
    const index = made.length;
    made.push({
      id,
      apId: `https://${instance.domain}/ap/comment/${id}`,
      local: instance.local,
      instanceId: instance.id,
      postId: post.id,
      parentId: parent?.id ?? null,
      authorId: authors[next(authors.length)]!.id,
      path: parent ? `${parent.path}.${id}` : id,
      level: (parent?.level ?? 0) + 1,
      bodyMd: `Comment ${index} with **some** *Markdown*, a [link](https://example.test/${index}) and \`code\`.\n\nA second paragraph for comment ${index}.`,
      upvotes: next(60),
      downvotes: next(15),
      publishedAt: new Date(start + index * 60_000),
    });
  };
  for (let level = 1; level <= depth; level++) add(made.at(-1) ?? null);
  while (made.length < size) {
    const parent = made[next(made.length)]!;
    // About one in twelve is a new top-level comment; nothing goes below the deepest level.
    add(next(12) === 0 || parent.level >= depth ? null : parent);
  }
  for (let from = 0; from < made.length; from += 100) {
    await writer()
      .insert(comments)
      .values(made.slice(from, from + 100).map(({ level: _level, ...row }) => row));
  }
  await recount(post.id);
  return made;
}

/**
 * A complete tree in a few bulk inserts: `shape[0]` top-level comments, each with `shape[1]`
 * replies, each with `shape[2]`, and so on. Scores vary and times rise with the insert order.
 * Counts are set at the end. Returns every comment, parents before children.
 */
export async function seedTree(instance: Instance, post: Row, authors: readonly Row[], shape: readonly number[]) {
  const made: (typeof comments.$inferInsert & { id: string; path: string })[] = [];
  const start = Date.now() - 100_000_000;
  const grow = (parent: (typeof made)[number] | null, levels: readonly number[]) => {
    const [width = 0, ...rest] = levels;
    for (let child = 0; child < width; child++) {
      const id = uuidv7();
      const index = made.length;
      const row = {
        id,
        apId: `https://${instance.domain}/ap/comment/${id}`,
        local: instance.local,
        instanceId: instance.id,
        postId: post.id,
        parentId: parent?.id ?? null,
        authorId: authors[index % authors.length]!.id,
        path: parent ? `${parent.path}.${id}` : id,
        bodyMd: `Comment ${index}`,
        upvotes: (index * 7) % 23,
        downvotes: index % 5,
        publishedAt: new Date(start + index * 1_000),
      };
      made.push(row);
      grow(row, rest);
    }
  };
  grow(null, shape);
  for (let from = 0; from < made.length; from += 200)
    await writer()
      .insert(comments)
      .values(made.slice(from, from + 200));
  await recount(post.id);
  return made;
}

/**
 * The world of the comment policy table: B1's people and communities, and the comments the
 * table asks about.
 * - `local` are `reader`'s comments on the author's posts in the open community: `normal`,
 *   `deleted` and `removed` on the normal post, and one each under the locked, removed and
 *   deleted post and in the removed community;
 * - `banned` is the banned person's comment, `remote` the remote author's on the remote post;
 * - `deep` is a chain of 50 comments by `reader` on its own post: `level49` takes a reply,
 *   `level50` does not.
 */
export async function seedCommentWorld() {
  const world = await seedPostWorld();
  const { local, lemmy } = world.instances;
  const { people, communities } = world;
  const on = (postId: string, extra: Partial<typeof comments.$inferInsert> = {}) =>
    seedReply(local, { id: postId }, null, people.reader, extra).then(({ id }) => id);
  const states = world.posts.local;
  const deepPost = await seedPost(local, communities.open, people.author);
  const chain = await seedChain(local, deepPost, people.reader, 50);
  const parentPath = chain[48]!;
  return {
    ...world,
    posts: { ...world.posts, deep: deepPost.id },
    comments: {
      local: {
        normal: await on(states.normal),
        deleted: await on(states.normal, { deletedAt: past() }),
        removed: await on(states.normal, { removedAt: past() }),
        onLocked: await on(states.locked),
        onRemovedPost: await on(states.removed),
        onDeletedPost: await on(states.deleted),
        inRemovedCommunity: await on(states['community removed']),
      },
      banned: (await seedReply(local, { id: states.normal }, null, people.banned)).id,
      remote: (await seedReply(lemmy, { id: world.posts.remote.normal }, null, people.remoteAuthor)).id,
      deep: { level49: parentPath.id, level50: chain[49]!.id },
    },
  };
}

/**
 * What e2e/comments runs against: accounts that can sign in (lane A's seedAccount), a community
 * with a moderator and these posts, each with its own thread:
 * - `thread`: top-level comments `first` (the best scored), `second` and `third`, a reply to
 *   `first`, and a chain under `second` that goes 8 levels deep (so "Continue this thread" shows);
 * - `tombstones`: a deleted comment and a removed one, each with a reply;
 * - `removed`: a post a moderator removed, with a comment;
 * - `empty`: no comments; `locked`: a locked post with one comment;
 * - `paged`: a page of top-level comments and three more, `Comment 0` to `Comment N` oldest first;
 *   `pagedReplies`: one comment (`pagedRoot`) with a page of replies and three more;
 * - `big`: 500 comments reaching level 50.
 * Every run uses fresh names, so the lane database can keep earlier runs.
 */
async function e2e() {
  const { seedAccount: seedLogin, PASSWORD } = await import('./seed-a.ts');
  const { localInstance } = await import('../db/local-instance.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = (await localInstance(db())).origin;
  const instance = { ...(await localInstance(db())), domain: new URL(origin).host, local: true };
  const [author, replier, moderator, unverified] = await Promise.all([
    seedLogin(`author_${suffix}`),
    seedLogin(`replier_${suffix}`),
    seedLogin(`mod_${suffix}`),
    seedLogin(`unverified_${suffix}`, { emailVerified: false }),
  ]);
  const community = await seedActor(instance, 'Group', `d_${suffix}`);
  await seedModerator(community, { id: moderator.actorId });
  const poster = { id: author.actorId };
  const post = (title: string, extra: Partial<typeof posts.$inferInsert> = {}) =>
    seedPost(instance, community, poster, { title: `${title} ${suffix}`, bodyMd: title, contentHtml: `<p>${title}</p>`, ...extra });
  const body = (text: string) => ({ bodyMd: text, contentHtml: `<p>${text}</p>` });
  const commenter = { id: replier.actorId };

  const threadPost = await post('Thread post');
  const first = await seedReply(instance, threadPost, null, commenter, { ...body(`First comment ${suffix}`), upvotes: 9 });
  const firstReply = await seedReply(instance, threadPost, first, poster, body(`Reply to first ${suffix}`));
  const second = await seedReply(instance, threadPost, null, poster, { ...body(`Second comment ${suffix}`), upvotes: 3 });
  const third = await seedReply(instance, threadPost, null, commenter, { ...body(`Third comment ${suffix}`), upvotes: 1 });
  const chain: Parent[] = [second];
  for (let level = 2; level <= 8; level++)
    chain.push(await seedReply(instance, threadPost, chain.at(-1)!, commenter, body(`Chain level ${level} ${suffix}`)));

  const tombstonePost = await post('Tombstone post');
  const deleted = await seedReply(instance, tombstonePost, null, commenter, { ...body(`Deleted text ${suffix}`), deletedAt: past() });
  await seedReply(instance, tombstonePost, deleted, poster, body(`Reply under deleted ${suffix}`));
  // Removed through the real mutation, so the modlog holds the moderator's reason.
  const removed = await seedReply(instance, tombstonePost, null, commenter, body(`Removed text ${suffix}`));
  await removeContent(
    await grantFor(
      'mod.remove',
      { kind: 'local', actorId: moderator.actorId, siteRole: 'user' },
      { target: { kind: 'comment', id: removed.id } },
    ),
    {
      reason: 'Rule 3: no ads',
    },
  );
  await seedReply(instance, tombstonePost, removed, poster, body(`Reply under removed ${suffix}`));

  // A post a moderator removed keeps its comments from everyone but the moderators.
  const removedPost = await post('Removed post');
  await seedReply(instance, removedPost, null, commenter, body(`Under a removed post ${suffix}`));
  await removeContent(
    await grantFor(
      'mod.remove',
      { kind: 'local', actorId: moderator.actorId, siteRole: 'user' },
      { target: { kind: 'post', id: removedPost.id } },
    ),
    { reason: 'Off topic' },
  );

  const emptyPost = await post('Empty post');
  const lockedPost = await post('Locked post', { locked: true });
  await seedReply(instance, lockedPost, null, commenter, body(`Comment on locked ${suffix}`));

  const pagedPost = await post('Paged post');
  await seedTree(instance, pagedPost, [commenter, poster], [threadPageSize + 3]);
  const pagedRepliesPost = await post('Paged replies post');
  const [pagedRoot] = await seedTree(instance, pagedRepliesPost, [commenter, poster], [1, threadPageSize + 3]);

  const bigPost = await post('Big post');
  const crowd = await Promise.all(Array.from({ length: 5 }, (_, index) => seedLogin(`crowd${index}_${suffix}`)));
  await seedBigThread(
    instance,
    bigPost,
    crowd.map(({ actorId }) => ({ id: actorId })),
    500,
    50,
  );

  return {
    password: PASSWORD,
    suffix,
    community: { handle: community.name },
    author: { name: author.name, actorId: author.actorId },
    replier: { name: replier.name, actorId: replier.actorId },
    moderator: { name: moderator.name },
    unverified: { name: unverified.name },
    posts: {
      thread: threadPost.id,
      tombstones: tombstonePost.id,
      removed: removedPost.id,
      empty: emptyPost.id,
      locked: lockedPost.id,
      paged: pagedPost.id,
      pagedReplies: pagedRepliesPost.id,
      big: bigPost.id,
    },
    comments: {
      first: first.id,
      firstReply: firstReply.id,
      second: second.id,
      third: third.id,
      chain: chain.map(({ id }) => id),
      deleted: deleted.id,
      removed: removed.id,
      pagedRoot: pagedRoot!.id,
    },
  };
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else throw new Error('usage: node packages/core/src/testing/seed-d.ts e2e');
  } finally {
    await closePools();
  }
}
