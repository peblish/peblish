import type { ActorRef, PostView } from '@peblish/schema/views';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { PostCard } from './post-card.tsx';
import { PostRow, type PostRowLabels } from './post-row.tsx';

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

const labels: PostRowLabels = {
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
  hide: 'Hide',
  cover: { hidden: 'NSFW content hidden', show: 'Show' },
};

const render = (thumbnailSrc: string | null, extra: Partial<PostView> = {}) =>
  renderToStaticMarkup(
    <PostRow
      post={{ ...post, ...extra }}
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

test('PostCard is still PostRow, for the routes that import it by its former name', () => {
  expect(PostCard).toBe(PostRow);
});

test('the thumbnail is a Mux Link to the post, out of the tab order and hidden from assistive technology', () => {
  const thumb = /<a [^>]*class="[^"]*pb-post__thumb[^"]*"[^>]*>/.exec(render('/media/proxy/signed/thumb'))?.[0];
  expect(thumb).toContain('muxui-link');
  expect(thumb).toContain('href="/post/1"');
  expect(thumb).toContain('tabindex="-1"');
  expect(thumb).toContain('aria-hidden="true"');
});

test('without a resolved source the row has no thumbnail and loads nothing, whatever the post carries', () => {
  const html = render(null);
  expect(html).not.toContain('<img');
  expect(html).not.toContain('tracker.example');
  expect(html).not.toContain('pb-post__thumb');
});

test('a sensitive post renders the cover in place of its picture: no image, nothing focusable, a named Show', () => {
  const html = render('/media/proxy/signed/thumb', { sensitive: true });
  expect(html).toContain('data-hidden="true"');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('/media/proxy/signed/thumb');
  expect(html).toMatch(/<div class="pb-cover[^"]*"[^>]*data-size="thumb"/);
  expect(html).toContain('NSFW content hidden');
  // Disabled on the server: Show needs scripts.
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*Show/);
});

test('a revealed sensitive post shows its picture and a Hide action; one the page keeps covered keeps it out', () => {
  const shown = renderToStaticMarkup(
    <PostRow
      post={{ ...post, sensitive: true }}
      density="card"
      hrefs={{ post: '/post/1', community: '/c/news', author: '/u/jun' }}
      labels={labels}
      locale="en-US"
      thumbnailSrc="/media/proxy/signed/thumb"
      cover={{ revealed: true }}
    />,
  );
  expect(shown).toContain('src="/media/proxy/signed/thumb"');
  expect(shown).toMatch(/<button[^>]*><span class="muxui-button__label">Hide<\/span><\/button>/);
  expect(shown).not.toContain('data-hidden');
});

test('the comments link shows the number and is named by the count', () => {
  expect(render(null)).toMatch(/<a [^>]*aria-label="0 comments"[^>]*class="[^"]*pb-post__comments/);
});

test('a Card link post says where it goes in a link line to the address; Classic keeps the domain after the title', () => {
  const card = renderWith(labels);
  expect(card).toMatch(
    /<a [^>]*class="[^"]*pb-link-preview[^"]*"[^>]*href="https:\/\/example.com\/article"[^>]*rel="noopener noreferrer nofollow ugc"/,
  );
  expect(card).not.toContain('pb-post__domain');
  expect(render(null)).toContain('pb-post__domain');
});

const renderWith = (labels: PostRowLabels, extra: Partial<PostView> = {}) =>
  renderToStaticMarkup(
    <PostRow
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
  const html = render(null, { url: 'https://example.com/a' });
  expect(html).toMatch(/<bdi dir="ltr">\(example\.com\)<\/bdi>/);
});

test('a title with a right-to-left override is an isolated run drawn without its directional controls', () => {
  // The vote group's name shows each control as the replacement mark, as the inbox's buttons do.
  const html = renderWith(labels, { title: 'Plain ‮evil⁦ title' });
  expect(html).toContain('<bdi>Plain evil title</bdi>');
  expect(html).toContain('aria-label="Vote: Plain \u203Devil\u203D title"');
  expect(html).not.toMatch(/[‪-‮⁦-⁩‎‏؜]/);
});
