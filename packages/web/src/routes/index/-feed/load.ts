import { defaultPageSize, Period, Sort, type FeedName } from '@peblish/core/feeds/input';
import { readFeed } from '@peblish/core/feeds/read';
import { isImageContentType } from '@peblish/core/media/image-src';
import type { Viewer } from '@peblish/core/posts/read';
import type { PostView } from '@peblish/schema/views';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../../server/auth.ts';
import { createMarkdownRenderer } from '../../../server/markdown.ts';

/** One post of a page: the view, and the picture the card may load (already through the proxy rule). */
export type FeedItem = { post: PostView; thumbnailSrc: string | null };

/**
 * A feed page for the route loader (a server function: it runs on the server for a document
 * request and over fetch for a client-side navigation). `home` is the front page: Subscribed
 * for a signed-in person, Local for anyone else. The reply depends on who asks, so it is
 * private (pageSession says so). Subscribed and Moderating without a viewer are answered with
 * `signIn: true` and no posts.
 */
export const loadFeed = createServerFn({ method: 'GET' })
  .validator(type({ feed: "'home' | 'local' | 'all' | 'popular' | 'moderating'", sort: Sort, period: Period, 'cursor?': 'string <= 400' }))
  .handler(async ({ data }) => {
    const session = await pageSession();
    const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
    const feed: FeedName = data.feed === 'home' ? (viewer ? 'subscribed' : 'local') : data.feed;
    // `now` is the clock the card ages are printed against, so the server's text and the browser's hydrate the same.
    const base = { feed, signedIn: viewer !== null, now: new Date().toISOString() };
    if (!viewer && feed === 'moderating') return { ...base, signIn: true, items: [] as FeedItem[], next: null };

    const page = await readFeed({ feed, sort: data.sort, period: data.period, cursor: data.cursor, limit: defaultPageSize }, viewer);
    // Remote pictures reach the viewer only through the signed proxy (decision 5): own-origin
    // URLs pass, remote ones are signed, anything else is null. An image post shows its image.
    const renderer = await createMarkdownRenderer();
    const items = page.items.map((post): FeedItem => ({
      post,
      thumbnailSrc: renderer.image(post.thumbnailUrl ?? (isImageContentType(post.urlContentType) ? post.url : null)),
    }));
    return { ...base, signIn: false, items, next: page.next };
  });

export type FeedData = Awaited<ReturnType<typeof loadFeed>>;
