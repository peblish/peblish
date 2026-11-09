import { newObjectApId } from '@peblish/schema/actor-urls';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { renderLocalBody } from './body.ts';
import { NewPost, normalizeTitle } from './input.ts';

/**
 * The reference mutation every write service follows. The policy (authz/actions/posts.ts)
 * lets a verified local person post, and lane F's restricted communities admit only their
 * staff; it rechecks inside the transaction because a ban, a deleted community or a
 * restriction can land after authorize().
 *
 * The input is validated here as well as at the caller's boundary. A post in a sensitive
 * community is sensitive, and one in an NSFL community NSFL; NSFL implies sensitive, so peers
 * that only know the one flag still hide it. content_html is rendered here, once: it is what
 * federates (lane FED-A); pages render bodyMd themselves.
 */
export const createPost = defineMutation({
  action: 'post.create',
  emits: ['post.created'],
  recheck: true,
  async run(t, grant, raw: NewPost) {
    // A peer's post goes through storeRemotePost (sanitised, with the peer's id and times); this one writes a local post.
    if (grant.principal.kind !== 'local') throw new Refused('post.create', 'auth.required');
    const input = NewPost.assert(raw);
    const instance = await localInstance(t.db);
    const id = uuidv7();
    const { communityId } = grant.subject;
    // The recheck holds the community row, so these flags are the ones the policy saw.
    const [community] = await t.db
      .select({ sensitive: actors.sensitive, nsfl: actors.nsfl })
      .from(actors)
      .where(eq(actors.id, communityId));
    const nsfl = Boolean(input.nsfl) || community?.nsfl === true;
    const apId = newObjectApId(instance.origin, 'post', id);
    await t.db.insert(posts).values({
      id,
      apId,
      local: true,
      instanceId: instance.id,
      authorId: grant.actorId,
      communityId,
      title: normalizeTitle(input.title),
      url: input.url ?? null,
      urlContentType: input.urlContentType ?? null,
      altText: input.altText ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      bodyMd: input.bodyMd || null,
      contentHtml: renderLocalBody(input.bodyMd, instance.origin, id),
      language: input.language ?? null,
      sensitive: Boolean(input.sensitive) || nsfl || community?.sensitive === true,
      nsfl,
      publishedAt: new Date(),
    });
    await t.emit({ type: 'post.created', v: 1, postId: id, communityId, authorId: grant.actorId, local: true });
    return { id, apId };
  },
});
