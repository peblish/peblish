import type { PostPage } from '@peblish/core/posts/read';
import type { ActorRef, PostView } from '@peblish/schema/views';
import { describe, expect, test, vi } from 'vitest';

// The post page's loader itself (its handler, with createServerFn handing it back as it is): a
// removed post's author reaches the page data only for its author and the moderators.

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({ validator: () => ({ handler: <F>(fn: F) => fn }) }),
}));
vi.mock('@tanstack/react-start/server', () => ({ getRequestHeader: () => 'en' }));
const state = vi.hoisted(() => ({ viewer: 'reader', moderator: false }));
vi.mock('../../server/auth.ts', () => ({
  pageSession: async () => ({ view: { actorId: state.viewer, siteRole: 'user' } }),
}));
vi.mock('../../server/markdown.ts', () => ({
  createMarkdownRenderer: async () => ({ render: () => ({ html: '' }), sanitize: () => ({ html: '' }), image: () => null }),
}));
vi.mock('../c/-gate.ts', () => ({ requestNsfw: () => ({ always: false, once: [] }), gateData: () => null }));
vi.mock('./$id/comments/-thread.ts', () => ({ loadThread: async () => null }));
vi.mock('@peblish/core/config', () => ({ publicOrigin: () => 'https://feddit.test' }));
vi.mock('@peblish/core/posts/read', () => ({ readPost: async () => page(state.moderator) }));
const { loadPost } = await import('./-load.ts');

const carol: ActorRef = {
  id: '019a0000-0000-7000-8000-0000000ca201',
  apId: 'https://other.example/users/carol',
  kind: 'Person',
  name: 'carol',
  displayName: 'Carol in full',
  local: false,
  handle: 'carol@other.example',
};

function page(moderator: boolean): PostPage {
  const view: PostView = {
    id: '019a0000-0000-7000-8000-000000000b05',
    apId: 'https://other.example/users/carol/statuses/9',
    title: '',
    url: null,
    urlContentType: null,
    thumbnailUrl: null,
    contentHtml: null,
    excerpt: null,
    author: carol,
    authorBadge: 'moderator',
    community: {
      id: '019a0000-0000-7000-8000-0000000c0111',
      apId: 'https://feddit.test/c/news',
      kind: 'Group',
      name: 'news',
      displayName: null,
      local: true,
      handle: 'news',
    },
    publishedAt: '2026-11-01T00:00:00.000Z',
    editedAt: null,
    sensitive: false,
    nsfl: false,
    locked: false,
    featured: false,
    deleted: false,
    removed: true,
    counts: { upvotes: 0, downvotes: 0, comments: 0 },
    myVote: 0,
  };
  return { view, body: null, gate: 'none', moderator };
}

const load = async (viewer: string, moderator: boolean) => {
  Object.assign(state, { viewer, moderator });
  return JSON.stringify(await loadPost({ data: { id: '019a0000-0000-7000-8000-000000000b05' } }));
};

describe('a removed post', () => {
  test('reaches a reader without its author', async () => {
    const text = await load('reader', false);
    for (const trace of [carol.id, carol.name, carol.displayName!, carol.handle, carol.apId]) {
      expect([trace, text.includes(trace)]).toEqual([trace, false]);
    }
  });

  test('reaches its author and the moderators as before', async () => {
    for (const [viewer, moderator] of [
      [carol.id, false],
      ['reader', true],
    ] as const) {
      expect(await load(viewer, moderator)).toContain(carol.handle);
    }
  });
});
