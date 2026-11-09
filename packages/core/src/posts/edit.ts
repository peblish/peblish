import { eq } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { renderLocalBody } from './body.ts';
import { normalizeTitle, PostEdit } from './input.ts';

const keep = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);

/**
 * The author's edit of their own post (local or, through updateRemotePost, remote). Only the
 * fields present change; a post still in a sensitive community stays sensitive. An edit that
 * changes nothing writes nothing and emits nothing, so "edited" only ever means an edit. The
 * body is rendered again when it changed, like createPost.
 */
export const updatePost = defineMutation({
  action: 'post.update',
  emits: ['post.updated'],
  recheck: true,
  async run(t, grant, raw: PostEdit) {
    const input = PostEdit.assert(raw);
    const { postId } = grant.subject;
    const [post] = await t.db.select().from(posts).where(eq(posts.id, postId));
    if (!post) throw new Refused('post.update', 'target.not_found');
    const [community] = await t.db
      .select({ sensitive: actors.sensitive, nsfl: actors.nsfl })
      .from(actors)
      .where(eq(actors.id, post.communityId));
    const nsfl = keep(input.nsfl, post.nsfl) || community?.nsfl === true;
    const next = {
      title: input.title === undefined ? post.title : normalizeTitle(input.title),
      url: keep(input.url, post.url),
      urlContentType: keep(input.urlContentType, post.urlContentType),
      altText: keep(input.altText, post.altText),
      thumbnailUrl: keep(input.thumbnailUrl, post.thumbnailUrl),
      language: keep(input.language, post.language),
      bodyMd: input.bodyMd === undefined ? post.bodyMd : input.bodyMd || null,
      sensitive: keep(input.sensitive, post.sensitive) || nsfl || community?.sensitive === true,
      nsfl,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).some((key) => next[key] !== post[key]);
    if (!changed) return { changed: false };
    const { origin } = await localInstance(t.db);
    await t.db
      .update(posts)
      .set({
        ...next,
        contentHtml: next.bodyMd === post.bodyMd ? post.contentHtml : renderLocalBody(next.bodyMd, origin, postId),
        editedAt: new Date(),
      })
      .where(eq(posts.id, postId));
    await t.emit({ type: 'post.updated', v: 1, postId, communityId: post.communityId, authorId: post.authorId, local: post.local });
    return { changed: true };
  },
});
