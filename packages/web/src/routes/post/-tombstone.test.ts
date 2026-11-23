import { proxyUrlBuilder } from '@peblish/core/media/proxy-url';
import type { Thread, ThreadComment } from '@peblish/core/comments/read';
import type { PostPage } from '@peblish/core/posts/read';
import type { SessionView } from '@peblish/schema/session';
import type { ActorRef, CommentView, PostView } from '@peblish/schema/views';
import { describe, expect, test } from 'vitest';
import { createMarkdownRenderer } from '../../server/markdown.ts';
import { threadData } from './$id/comments/-thread.ts';
import { postForViewer } from './-withheld.ts';

// What the post page's loader sends for a tombstone, as it is serialised into the page: the post
// (postForViewer, as -load.ts calls it) and its thread (threadData, what loadThread returns for
// core's read). The author's address and their posts' and comments' addresses hold their handle, as
// a federated server's do, so any trace of them shows in the JSON.

const site = { origin: 'https://feddit.example', remoteMedia: true, proxy: proxyUrlBuilder(Buffer.alloc(32, 7)) };

const actor = (id: string, name: string, kind: ActorRef['kind'] = 'Person'): ActorRef => ({
  id,
  apId: `https://social.example/users/${name}`,
  kind,
  name,
  displayName: `${name} Ward`,
  local: false,
  handle: `${name}@social.example`,
});
const alice = actor('0195f0a0-0000-7000-8000-00000000a11c', 'alice');
const bob = actor('0195f0a0-0000-7000-8000-000000000b0b', 'bob');
const community = actor('0195f0a0-0000-7000-8000-00000000c0c0', 'walks', 'Group');
/** Everything that names alice: her id, name, handle, display name and addresses. */
const traces = [alice.id, 'alice'];

const postView = (extra: Partial<PostView>): PostView => ({
  id: '0195f0a0-0000-7000-8000-000000000001',
  apId: 'https://social.example/users/alice/statuses/1',
  title: '',
  url: null,
  urlContentType: null,
  thumbnailUrl: null,
  contentHtml: null,
  excerpt: null,
  author: alice,
  authorBadge: 'moderator',
  community,
  publishedAt: '2026-11-20T09:00:00.000Z',
  editedAt: null,
  sensitive: false,
  nsfl: false,
  locked: false,
  featured: false,
  deleted: true,
  removed: false,
  counts: { upvotes: 3, downvotes: 0, comments: 3 },
  myVote: 0,
  ...extra,
});

const comment = (id: string, author: ActorRef, extra: Partial<CommentView>, text: string | null): ThreadComment => ({
  view: {
    id,
    apId: `https://social.example/users/${author.name}/statuses/${id.slice(-3)}`,
    postId: '0195f0a0-0000-7000-8000-000000000001',
    parentId: null,
    depth: 0,
    contentHtml: null,
    author,
    authorBadge: null,
    publishedAt: '2026-11-20T10:00:00.000Z',
    editedAt: null,
    deleted: false,
    removed: false,
    counts: { upvotes: 1, downvotes: 0, comments: 0 },
    myVote: 0,
    ...extra,
  },
  body: text === null ? null : { kind: 'markdown', source: text },
  removal: null,
});

/** A deleted post by alice: bob's comment, alice's deleted reply under it, and alice's removed comment. */
const comments = [
  comment('0195f0a0-0000-7000-8000-000000000101', bob, {}, 'A live reply by bob.'),
  comment(
    '0195f0a0-0000-7000-8000-000000000102',
    alice,
    { parentId: '0195f0a0-0000-7000-8000-000000000101', depth: 1, deleted: true, authorBadge: 'moderator' },
    null,
  ),
  comment('0195f0a0-0000-7000-8000-000000000103', alice, { removed: true }, null),
];

const session = (who: ActorRef): { view: SessionView } => ({
  view: {
    userId: '0195f0a0-0000-7000-8000-0000000000ee',
    actorId: who.id,
    name: who.name,
    displayName: null,
    siteRole: 'user',
    emailVerified: true,
    twoFactorEnabled: false,
    ageDeclaredAt: null,
  },
});

/** The post and thread parts of the loader's answer, for a viewer and whether they moderate here, as JSON. */
async function payload(view: PostView, viewer: ActorRef | null, moderator = false) {
  const renderer = await createMarkdownRenderer(site);
  const page: PostPage = { view, body: null, gate: 'none', moderator };
  const thread: Thread = { postId: view.id, sort: 'top', comments, focus: null, moderator, next: null };
  const data = {
    post: postForViewer(page, viewer?.id ?? null),
    thread: threadData({ page, session: viewer && session(viewer), renderer, after: null, thread }),
  };
  return { data, json: JSON.stringify(data) };
}

describe('a tombstone in the page data', () => {
  test('a deleted post and its thread carry nothing of the author to a signed-out viewer or a member', async () => {
    for (const viewer of [null, bob]) {
      const { data, json } = await payload(postView({}), viewer);
      for (const trace of traces) expect(json, `${viewer?.name ?? 'signed out'}: ${trace}`).not.toContain(trace);
      expect(data.post).toMatchObject({ deleted: true, apId: '', authorBadge: null, author: { handle: '', name: '' } });
      expect(data.thread.postAuthorId).toBeNull();
      // The nested and the top-level tombstone keep their place and flags, without an address.
      expect(data.thread.comments.map(({ deleted, removed, apId }) => ({ deleted, removed, apId }))).toEqual([
        { deleted: false, removed: false, apId: comments[0]!.view.apId },
        { deleted: true, removed: false, apId: '' },
        { deleted: false, removed: true, apId: '' },
      ]);
      // What is live stays as it was: bob's comment, the community.
      expect(json).toContain(bob.handle);
      expect(json).toContain(community.handle);
    }
  });

  test('a removed post carries nothing of its author to a member either', async () => {
    const { data } = await payload(postView({ deleted: false, removed: true }), bob);
    for (const trace of traces) expect(JSON.stringify(data.post)).not.toContain(trace);
  });

  test('staff get core’s view as it is; the author keeps their own post, to restore it', async () => {
    const staff = await payload(postView({}), bob, true);
    expect(staff.data.post).toEqual(postView({}));
    expect(staff.data.thread.postAuthorId).toBe(alice.id);
    expect(staff.data.thread.comments.map(({ author, apId }) => ({ author, apId }))).toEqual(
      comments.map(({ view }) => ({ author: view.author, apId: view.apId })),
    );
    const own = await payload(postView({}), alice);
    expect(own.data.post).toEqual(postView({}));
    expect(own.data.thread.postAuthorId).toBe(alice.id);
  });

  test('a live post keeps its author for everyone', async () => {
    const { data } = await payload(postView({ deleted: false, title: 'A walk' }), null);
    expect(data.post.author).toEqual(alice);
    expect(data.thread.postAuthorId).toBe(alice.id);
  });
});
