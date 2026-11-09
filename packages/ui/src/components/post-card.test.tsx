import type { ActorRef, PostView } from '@peblish/schema/views';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { PostCard, type PostCardLabels } from './post-card.tsx';

const actor = (name: string, kind: 'Person' | 'Group'): ActorRef => ({
  id: `00000000-0000-7000-9000-00000000000${kind === 'Group' ? 1 : 2}`,
  apId: `https://feddit.test/${name}`,
  kind,
  name,
  displayName: null,
  local: true,
  handle: name,
});

const post: PostView = {
  id: '00000000-0000-7000-8000-000000000001',
  apId: 'https://feddit.test/post/1',
  title: 'A link post',
  url: 'https://example.com/article',
  urlContentType: null,
  // A remote host: rendering this as an <img> would send the viewer's address to it.
  thumbnailUrl: 'https://tracker.example/pixel.png',
  contentHtml: null,
  excerpt: null,
  author: actor('jun', 'Person'),
  authorBadge: null,
  community: actor('news', 'Group'),
  publishedAt: '2026-11-09T09:00:00Z',
  editedAt: null,
  sensitive: false,
  nsfl: false,
  locked: false,
  featured: false,
  deleted: false,
  removed: false,
  counts: { upvotes: 3, downvotes: 0, comments: 0 },
  myVote: 0,
};

const labels: PostCardLabels = {
  vote: { group: 'Vote', up: 'Upvote', down: 'Downvote' },
  badges: { admin: 'admin', moderator: 'mod', op: 'OP' },
  pinned: 'Pinned',
  locked: 'Locked',
  nsfw: 'NSFW',
  nsfl: 'NSFL',
  removed: '[removed]',
  deleted: '[deleted]',
  comments: (count) => `${count} comments`,
  share: 'Share',
  show: 'show',
  hide: 'hide',
  by: 'by',
  text: 'Text',
  link: 'Link',
  image: 'Image',
};

const render = (thumbnailSrc: string | null) =>
  renderToStaticMarkup(
    <PostCard
      post={post}
      density="classic"
      hrefs={{ post: '/post/1', community: '/c/news', author: '/u/jun' }}
      labels={labels}
      locale="en-US"
      thumbnailSrc={thumbnailSrc}
      now={new Date('2026-11-09T12:00:00Z')}
    />,
  );

test('the thumbnail loads from the resolved source, never from the post own URL', () => {
  const html = render('/media/proxy/signed/thumb');
  expect(html).toContain('<img src="/media/proxy/signed/thumb"');
  expect(html).not.toContain('tracker.example');
});

test('without a resolved source the card shows its type mark and loads nothing, whatever the post carries', () => {
  const html = render(null);
  expect(html).not.toContain('<img');
  expect(html).not.toContain('tracker.example');
  expect(html).toContain('pb-post__mark');
});
