import type { PostPage } from '@peblish/core/posts/read';
import type { ActorRef, CommentView, PostView } from '@peblish/schema/views';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MarkdownRenderer } from '../../../../server/markdown.ts';

// What the thread's data tells a viewer about who wrote a tombstone: a deleted comment, and a
// deleted post (through the OP badge's postAuthorId), name no one to anyone but the author and the
// moderators. Checked on the serialised data, with authors whose addresses carry their handle.

const thread = vi.hoisted(() => ({ comments: [] as { view: CommentView; body: null; removal: null }[] }));
vi.mock('@peblish/core/comments/read', () => ({
  readThread: async (postId: string) => ({ postId, sort: 'hot', comments: thread.comments, focus: null, moderator: false, next: null }),
}));
vi.mock('@peblish/core/config', () => ({ publicOrigin: () => 'https://feddit.test' }));
const { loadThread } = await import('./-thread.ts');

const person = (id: string, name: string, host: string): ActorRef => ({
  id,
  apId: `https://${host}/users/${name}`,
  kind: 'Person',
  name,
  displayName: `${name} in full`,
  local: false,
  handle: `${name}@${host}`,
});
const alice = person('019a0000-0000-7000-8000-00000000a11c', 'alice', 'social.example');
const carol = person('019a0000-0000-7000-8000-0000000ca201', 'carol', 'other.example');
const reader = '019a0000-0000-7000-8000-0000000eade5';
const postId = '019a0000-0000-7000-8000-000000000b05';

const comment = (id: string, author: ActorRef, extra: Partial<CommentView> = {}): CommentView => ({
  id,
  apId: `${author.apId}/statuses/${id}`,
  postId,
  parentId: null,
  depth: 0,
  contentHtml: null,
  author,
  authorBadge: 'moderator',
  publishedAt: '2026-11-01T00:00:00.000Z',
  editedAt: null,
  deleted: false,
  removed: false,
  counts: { upvotes: 1, downvotes: 0, comments: 0 },
  myVote: 0,
  ...extra,
});

function pageOf(extra: Partial<PostView>, moderator = false): PostPage {
  const view: PostView = {
    id: postId,
    apId: `${carol.apId}/statuses/post`,
    title: '',
    url: null,
    urlContentType: null,
    thumbnailUrl: null,
    contentHtml: null,
    excerpt: null,
    author: carol,
    authorBadge: null,
    community: { ...person('019a0000-0000-7000-8000-0000000c0111', 'news', 'feddit.test'), kind: 'Group', local: true, handle: 'news' },
    publishedAt: '2026-11-01T00:00:00.000Z',
    editedAt: null,
    sensitive: false,
    nsfl: false,
    locked: false,
    featured: false,
    deleted: false,
    removed: false,
    counts: { upvotes: 0, downvotes: 0, comments: 2 },
    myVote: 0,
    ...extra,
  };
  return { view, body: null, gate: 'none', moderator };
}

// Every comment here is a tombstone or has no text, so nothing is rendered.
const rendered = { html: '', excerpt: '', links: [], truncated: false };
const renderer: MarkdownRenderer = { render: () => ({ ...rendered, mentions: [] }), sanitize: () => rendered, image: () => null };
const session = (actorId: string) => ({ view: { actorId, siteRole: 'user', emailVerified: true } }) as never;
const load = (page: PostPage, viewer: string | null) =>
  loadThread({ page, session: viewer ? session(viewer) : null, renderer, sort: 'hot', after: null });

/** Every way the data could name `who`: id, name, display name, handle and address. */
const traces = (who: ActorRef) => [who.id, who.name, who.displayName!, who.handle, who.apId];

beforeEach(() => {
  thread.comments = [
    { view: comment('019a0000-0000-7000-8000-00000000c001', carol), body: null, removal: null },
    { view: comment('019a0000-0000-7000-8000-00000000c002', alice, { deleted: true }), body: null, removal: null },
  ];
});

describe('a deleted comment', () => {
  test('names no author to a reader, signed in or out', async () => {
    for (const viewer of [reader, null]) {
      const text = JSON.stringify(await load(pageOf({}), viewer));
      for (const trace of traces(alice)) expect([viewer, trace, text.includes(trace)]).toEqual([viewer, trace, false]);
      // The live comment beside it is as before.
      expect(text).toContain(carol.handle);
    }
  });

  test('is as before for its author and for the moderators', async () => {
    const asModerator = await load(pageOf({}, true), reader);
    const asAuthor = await load(pageOf({}), alice.id);
    for (const data of [asModerator, asAuthor]) expect(data?.comments.map((row) => row.author)).toEqual([carol, alice]);
    expect(asModerator?.comments[1]).toEqual({ ...thread.comments[1]!.view, contentHtml: null });
  });
});

describe('a deleted post', () => {
  test('its author is not named through the badge its comments would carry', async () => {
    const data = await load(pageOf({ deleted: true }), reader);
    expect(data?.postAuthorId).not.toBe(carol.id);
    // The live comment by the same person keeps its own author line: the thread shows it.
    expect(data?.comments[0]?.author).toEqual(carol);
  });

  test('is as before for its author and for the moderators', async () => {
    expect((await load(pageOf({ deleted: true }, true), reader))?.postAuthorId).toBe(carol.id);
    expect((await load(pageOf({ deleted: true }), carol.id))?.postAuthorId).toBe(carol.id);
  });
});
