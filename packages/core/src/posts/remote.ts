import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { remoteBody } from './body.ts';
import { peerAltText, peerLanguage, peerLink, peerMediaType } from './input.ts';

// A peer's post, stored by lane FED-B's inbound handler. The caller has verified the
// activity (signature, origins, the claimed community; mapping/README.md, "What the caller
// checks") and authorizes as the remote author: post.create with { communityId } for a Create,
// post.update with { postId } for an Update. The author is the grant's actor, never a field.
// Deleting, undoing a delete and a peer's Delete of someone else's post use deletePost,
// restorePost and AZ's removeContent.

/** The fields of a mapped PostRecord (@peblish/federation/mapping/records) that a store reads. */
export type RemotePost = {
  apId: string;
  title: string;
  url: string | null;
  urlContentType: string | null;
  altText: string | null;
  thumbnailUrl: string | null;
  /** The Markdown `source`, when the peer sent one. */
  bodyMd: string | null;
  /** The peer's HTML `content`; sanitised here, never stored as sent. */
  contentHtml: string | null;
  sensitive: boolean;
  nsfl: boolean;
  language: string | null;
  /** Null when the peer sent no `published`: the receive time is used. */
  publishedAt: Date | null;
  /** The peer's `updated`; null when it sent none. */
  editedAt: Date | null;
  raw: unknown;
};

/** Longer remote titles are cut (Lemmy allows 200, PieFed and Mbin 255); the page lays out what is stored. */
const remoteTitleMaxLength = 500;

const cut = (text: string, max: number) => [...text.replace(/\s+/g, ' ').trim()].slice(0, max).join('');

/**
 * The fields a peer's author may set, as they are stored: the title cut, the link, preview,
 * media type, alt text and language held to limits (what fails is null), the body sanitised or
 * rendered, and the flags following the community's. Store and update share it, so an Update
 * can tell whether anything changed after the same transforms, not on the raw record.
 */
function editable(
  post: RemotePost,
  community: { sensitive: boolean; nsfl: boolean } | undefined,
  origin: string,
  postId: string,
  apId: string,
) {
  const nsfl = post.nsfl || community?.nsfl === true;
  return {
    title: cut(post.title, remoteTitleMaxLength),
    url: peerLink(post.url),
    urlContentType: peerMediaType(post.urlContentType),
    altText: peerAltText(post.altText),
    thumbnailUrl: peerLink(post.thumbnailUrl),
    ...remoteBody(post, origin, postId, apId),
    language: peerLanguage(post.language),
    sensitive: post.sensitive || nsfl || community?.sensitive === true,
    nsfl,
  };
}

/**
 * Locked and pinned state is not read from the author's document: an author could otherwise
 * lock or pin their own post. FED-B maps Lock and the featured collection to AZ's lock and pin
 * mutations, which a community's Announce authorizes; a PostRecord's `locked` and
 * `featuredCommunity` are ignored here, so those flags keep their stored value (false on a new post).
 *
 * An ap_id that is already stored is a redelivery only when it is the same author's post in the
 * same community; under another author or community it is post.id_conflict, so one peer's id
 * cannot be used to read or claim another's post.
 */
export const storeRemotePost = defineMutation({
  action: 'post.create',
  emits: ['post.created'],
  recheck: true,
  async run(t, grant, post: RemotePost) {
    if (grant.principal.kind !== 'remote')
      throw new TypeError("storeRemotePost stores a remote author's post; use createPost for a local one");
    const [existing] = await t.db
      .select({ id: posts.id, authorId: posts.authorId, communityId: posts.communityId })
      .from(posts)
      .where(eq(posts.apId, post.apId));
    if (existing) {
      if (existing.authorId !== grant.actorId || existing.communityId !== grant.subject.communityId)
        throw new Refused('post.create', 'post.id_conflict');
      // A redelivered Create (another activity id, the same object) changes nothing.
      return { id: existing.id, created: false };
    }
    const [author] = await t.db.select({ instanceId: actors.instanceId }).from(actors).where(eq(actors.id, grant.actorId));
    if (!author) throw new Refused('post.create', 'auth.required');
    const [community] = await t.db
      .select({ sensitive: actors.sensitive, nsfl: actors.nsfl })
      .from(actors)
      .where(eq(actors.id, grant.subject.communityId));
    const { origin } = await localInstance(t.db);
    const id = uuidv7();
    const fields = editable(post, community, origin, id, post.apId);
    await t.db.insert(posts).values({
      id,
      apId: post.apId,
      local: false,
      instanceId: author.instanceId,
      raw: post.raw,
      authorId: grant.actorId,
      communityId: grant.subject.communityId,
      ...fields,
      publishedAt: post.publishedAt ?? new Date(),
      editedAt: post.editedAt,
    });
    await t.emit({ type: 'post.created', v: 1, postId: id, communityId: grant.subject.communityId, authorId: grant.actorId, local: false });
    return { id, created: true };
  },
});

/**
 * A peer's Update by the author: replaces the editable fields, keeps `published`, the counts and
 * the flags a moderator sets. An Update that changes nothing (a redelivery, the direct copy after
 * the announced one) writes nothing and emits nothing, and does not move the edit time. A real
 * change takes the peer's `updated`, or the receive time when it sent none.
 */
export const updateRemotePost = defineMutation({
  action: 'post.update',
  emits: ['post.updated'],
  recheck: true,
  async run(t, grant, post: RemotePost) {
    const { postId } = grant.subject;
    const [current] = await t.db.select().from(posts).where(eq(posts.id, postId));
    if (!current) throw new Refused('post.update', 'target.not_found');
    if (current.apId !== post.apId) throw new TypeError('updateRemotePost: the record is not this post');
    const [community] = await t.db
      .select({ sensitive: actors.sensitive, nsfl: actors.nsfl })
      .from(actors)
      .where(eq(actors.id, current.communityId));
    const { origin } = await localInstance(t.db);
    const fields = editable(post, community, origin, postId, current.apId);
    const same = (Object.keys(fields) as (keyof typeof fields)[]).every((key) => fields[key] === current[key]);
    if (same && (post.editedAt === null || post.editedAt.getTime() === current.editedAt?.getTime())) return { id: postId };
    await t.db
      .update(posts)
      .set({ raw: post.raw, ...fields, editedAt: post.editedAt ?? new Date() })
      .where(eq(posts.id, postId));
    await t.emit({ type: 'post.updated', v: 1, postId, communityId: current.communityId, authorId: current.authorId, local: false });
    return { id: postId };
  },
});
