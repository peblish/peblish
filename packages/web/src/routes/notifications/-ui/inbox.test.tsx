import type { InboxItem } from '@peblish/core/notifications/view';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

// A notice row's first paint, as a browser without scripts (or before hydration) gets it: no router,
// so the hooks the row uses are stubbed, and every key prints as itself.
vi.mock('../../../i18n/use-translate.ts', () => ({ useTranslate: () => ({ locale: 'en', t: (_area: string, key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({ useLoaderData: () => '' }),
  rootRouteId: '__root__',
  useLocation: () => ({}),
  useRouter: () => ({ invalidate: async () => {} }),
}));
vi.mock('../../../shell/hydration.ts', () => ({ useRouteHydrated: () => {} }));
vi.mock('../../../shell/view-header.tsx', () => ({ useHeadingInView: () => false, ViewHeader: () => null }));

const { NoticeRow } = await import('./inbox.tsx');

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const community = { id: id(9), name: 'art', displayName: null, local: true, handle: 'art' };
const jun = { id: id(8), name: 'jun', displayName: null, local: true, handle: 'jun' };

/** A reply in a sensitive community, as the inbox sends it. */
const reply = (extra: Partial<InboxItem>): InboxItem => ({
  id: id(1),
  kind: 'reply',
  read: false,
  createdAt: '2026-11-20T10:00:00.000Z',
  actor: null,
  actorWithheld: null,
  community,
  postId: id(100),
  commentId: id(200),
  postTitle: null,
  about: 'comment',
  replyTo: 'post',
  withheld: 'sensitive',
  excerpt: null,
  statement: null,
  ...extra,
});

/** The hrefs of the row's Reply links (a button link; the row's other links are plain). */
const replyLinks = (item: InboxItem) => {
  const html = renderToStaticMarkup(<NoticeRow item={item} now="2026-11-20T12:00:00.000Z" submit={() => {}} page={{}} />);
  return [...html.matchAll(/<a [^>]*class="[^"]*pb-button-link[^"]*"[^>]*href="([^"]*)"/g)].map((match) => match[1]);
};

test('a notice that withholds its post offers no Reply: there is nothing it could lead to', () => {
  expect(replyLinks(reply({ actorWithheld: 'sensitive', postId: null, commentId: null }))).toEqual([]);
});

test('a sensitive notice whose comment the recipient may open leads Reply to that comment, as before', () => {
  expect(replyLinks(reply({ actor: jun }))).toEqual([`/post/${id(100)}/comments/${id(200)}`]);
});
