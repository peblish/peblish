import type { PostView } from '@peblish/schema/views';
import { expect, test } from 'vitest';
import { feedItem } from './items.ts';

const person = {
  id: '018f0000-0000-7000-8000-000000000001',
  apId: 'https://lemmy.test/u/a',
  kind: 'Person',
  name: 'a',
  displayName: null,
  local: false,
  handle: 'a@lemmy.test',
} as const;
const post = (extra: Partial<PostView>): PostView => ({
  id: '018f0000-0000-7000-8000-000000000002',
  apId: 'https://lemmy.test/post/1',
  title: 'A post',
  url: null,
  urlContentType: null,
  thumbnailUrl: null,
  contentHtml: null,
  excerpt: null,
  author: person,
  authorBadge: null,
  community: { ...person, id: '018f0000-0000-7000-8000-000000000003', kind: 'Group', name: 'c', handle: 'c@lemmy.test' },
  publishedAt: '2026-11-09T12:00:00.000Z',
  editedAt: null,
  sensitive: false,
  nsfl: false,
  locked: false,
  featured: false,
  deleted: false,
  removed: false,
  counts: { upvotes: 1, downvotes: 0, comments: 0 },
  myVote: 0,
  ...extra,
});
/** A resolver that signs every address the way the proxy does, so a test can see what was asked for. */
const proxy = (url: string | null) => (url ? `/media/proxy?u=${encodeURIComponent(url)}` : null);

test('an image post sends the resolved source and only the origin of its picture', () => {
  const item = feedItem(post({ url: 'https://images.example.test/a/b.png?token=1', urlContentType: 'image/png' }), proxy);
  expect(item.thumbnailSrc).toBe('/media/proxy?u=https%3A%2F%2Fimages.example.test%2Fa%2Fb.png%3Ftoken%3D1');
  expect(item.post.url).toBe('https://images.example.test');
  expect(item.post.thumbnailUrl).toBeNull();
  expect(JSON.stringify(item.post)).not.toContain('b.png');
});

test('a thumbnail is resolved and its own address left out; a link keeps its address', () => {
  const link = feedItem(post({ url: 'https://example.test/article', thumbnailUrl: 'https://images.example.test/t.jpg' }), proxy);
  expect(link.thumbnailSrc).toBe('/media/proxy?u=https%3A%2F%2Fimages.example.test%2Ft.jpg');
  expect(link.post).toMatchObject({ url: 'https://example.test/article', thumbnailUrl: null });
});

test('an image whose address does not resolve, or does not parse, leaves no address either', () => {
  const unresolved = feedItem(post({ url: 'https://images.example.test/a.png', urlContentType: 'image/webp' }), () => null);
  expect(unresolved).toMatchObject({ thumbnailSrc: null, post: { url: 'https://images.example.test' } });
  expect(feedItem(post({ url: '/relative/a.png', urlContentType: 'image/png' }), () => null).post.url).toBeNull();
});

test('a text post and an SVG link pass through', () => {
  expect(feedItem(post({}), proxy)).toMatchObject({ thumbnailSrc: null, post: { url: null } });
  const svg = feedItem(post({ url: 'https://images.example.test/a.svg', urlContentType: 'image/svg+xml' }), proxy);
  expect(svg).toMatchObject({ thumbnailSrc: null, post: { url: 'https://images.example.test/a.svg' } });
});
