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
  expect(html).toMatch(/<img [^>]*src="\/media\/proxy\/signed\/thumb"/);
  expect(html).not.toContain('tracker.example');
});

test('the thumbnail is a Mux Link to the post, out of the tab order and hidden from assistive technology', () => {
  const thumb = /<a [^>]*class="[^"]*pb-post__thumb[^"]*"[^>]*>/.exec(render('/media/proxy/signed/thumb'))?.[0];
  expect(thumb).toContain('muxui-link');
  expect(thumb).toContain('href="/post/1"');
  expect(thumb).toContain('tabindex="-1"');
  expect(thumb).toContain('aria-hidden="true"');
});

test('without a resolved source the card shows its type mark and loads nothing, whatever the post carries', () => {
  const html = render(null);
  expect(html).not.toContain('<img');
  expect(html).not.toContain('tracker.example');
  expect(html).toContain('pb-post__mark');
});

const renderWith = (labels: PostCardLabels, extra: Partial<PostView> = {}) =>
  renderToStaticMarkup(
    <PostCard
      post={{ ...post, ...extra }}
      density="card"
      hrefs={{ post: '/post/1', community: '/c/news', author: '/u/jun' }}
      labels={labels}
      locale="en-US"
      thumbnailSrc={null}
      now={new Date('2026-11-09T12:00:00Z')}
    />,
  );

// A screen reader moving between posts' controls must hear which post each belongs to.
test('the article is named by its heading, and the vote group by the post title through the pattern', () => {
  const html = renderWith({ ...labels, voteOn: (title) => `Vote on ${title}` });
  const id = /<article aria-labelledby="([^"]+)"/.exec(html)?.[1];
  expect(id).toBeTruthy();
  expect(html).toMatch(new RegExp(`<h2 class="[^"]*pb-post__title[^"]*" id="${id}"`));
  expect(html).toMatch(/<div aria-label="Vote on A link post"[^>]*role="group"/);
});

test('without a pattern the vote group still names the post, after the plain group name', () => {
  expect(renderWith(labels)).toMatch(/<div aria-label="Vote: A link post"[^>]*role="group"/);
  // A removed post is named as the card shows it, never by the title it hides.
  const removed = renderWith({ ...labels, voteOn: (title) => `Vote on ${title}` }, { removed: true });
  expect(removed).toMatch(/aria-label="Vote on \[removed\]"/);
  expect(removed).not.toContain('A link post');
});

test('a link post domain is a left-to-right isolated run with its directional controls neutralised', () => {
  const html = renderWith(labels, { url: 'https://example.com/a' });
  expect(html).toMatch(/<bdi dir="ltr">\(example\.com\)<\/bdi>/);
});

test('a title with a right-to-left override is an isolated run drawn without its directional controls', () => {
  // The vote group's name shows each control as the replacement mark, as the inbox's buttons do.
  const html = renderWith(labels, { title: 'Plain ‮evil⁦ title' });
  expect(html).toContain('<bdi>Plain evil title</bdi>');
  expect(html).toContain('aria-label="Vote: Plain \u203Devil\u203D title"');
  expect(html).not.toMatch(/[‪-‮⁦-⁩‎‏؜]/);
});
