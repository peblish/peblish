import { defaultPageSize, maxPageSize, Period, Sort } from '@peblish/core/feeds/input';
import { readFeed } from '@peblish/core/feeds/read';
import type { Viewer } from '@peblish/core/posts/read';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { pageSession } from '../../../server/auth.ts';
import { createMarkdownRenderer } from '../../../server/markdown.ts';
import { feedItem, type FeedItem } from './items.ts';
import { routeFeed } from './names.ts';
import { input } from '../../../server/input.ts';
import { maxDepth } from './search.ts';

/**
 * A feed page for the route loader (a server function: it runs on the server for a document
 * request and over fetch for a client-side navigation), and each batch the list loads after it.
 * `home` is the front page: Subscribed for a signed-in person, Local for anyone else. The reply
 * depends on who asks, so it is private (pageSession says so). Subscribed and Moderating without
 * a viewer are answered with `signIn: true` and no posts.
 *
 * `n` is how many rows to read (one batch when absent): the feed's own reads, up to 50 rows each,
 * one after another along the cursor, so a reader who comes back to row 200 gets them fresh in one
 * answer, in the feed's order and under its conditions. A request the browser has given up on (the
 * reader left) stops between reads.
 */
export const loadFeed = createServerFn({ method: 'GET' })
  .validator(
    input(
      type({
        feed: "'home' | 'local' | 'all' | 'popular' | 'moderating'",
        sort: Sort,
        period: Period,
        'cursor?': 'string <= 400',
        'n?': type('number.integer % 20').atLeast(defaultPageSize).atMost(maxDepth),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const session = await pageSession();
    const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
    const feed = routeFeed(data.feed, viewer !== null);
    const want = data.n ?? defaultPageSize;
    // `now` is the clock the card ages are printed against, so the server's text and the browser's hydrate the same.
    const base = { feed, signedIn: viewer !== null, now: new Date().toISOString(), n: want };
    if (!viewer && feed === 'moderating') return { ...base, signIn: true, items: [] as FeedItem[], next: null };

    const { signal } = getRequest();
    const posts = [];
    let next: string | null = null;
    let cursor = data.cursor;
    do {
      const page = await readFeed(
        { feed, sort: data.sort, period: data.period, cursor, limit: Math.min(maxPageSize, want - posts.length) },
        viewer,
      );
      posts.push(...page.items);
      next = page.next;
      cursor = next ?? undefined;
    } while (next !== null && posts.length < want && !signal.aborted);
    // Remote pictures reach the viewer only through the signed proxy (decision 5): own-origin
    // URLs pass, remote ones are signed, anything else is null. An image post shows its image.
    const renderer = await createMarkdownRenderer();
    const items = posts.map((post) => feedItem(post, renderer.image));
    return { ...base, signIn: false, items, next };
  });

export type FeedData = Awaited<ReturnType<typeof loadFeed>>;
