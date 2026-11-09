import { readPost, type Viewer } from '@peblish/core/posts/read';
import type { PostView } from '@peblish/schema/views';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { negotiateLocale } from '../../i18n/negotiate.ts';
import { pageSession } from '../../server/auth.ts';
import { createMarkdownRenderer } from '../../server/markdown.ts';
import { loadThread } from './$id/comments/-thread.ts';
import { postMedia, postTime, threadVisible } from './-page-data.ts';

/**
 * The post page's data, for the route loader (a server function: it runs on the server for a
 * document request and over fetch for a client-side navigation). Lane D adds its one loader
 * call for the thread here, beside readPost. Everything that depends on who looks (the gate,
 * a tombstone, a removed post) is decided in core's readPost; this renders what it hands over.
 */
export const loadPost = createServerFn({ method: 'GET' })
  .validator(type({ id: 'string' }))
  .handler(async ({ data }) => {
    const session = await pageSession();
    const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
    const page = await readPost(data.id, viewer);
    if (!page) return null;
    const renderer = await createMarkdownRenderer();
    const { body } = page;
    const contentHtml =
      body?.kind === 'markdown'
        ? renderer.render(body.source, { idPrefix: page.view.id }).html
        : body
          ? renderer.sanitize(body.html, { baseUrl: body.baseUrl }).html
          : null;
    const { view } = page;
    const { thumbnail, image } = postMedia(view, renderer);
    const locale = negotiateLocale(getRequestHeader('accept-language'));
    // The page draws `thumbnail` (through the proxy rule); the picture's own address stays out of the page data.
    const post: PostView = { ...view, thumbnailUrl: null, contentHtml };
    return {
      post,
      gate: page.gate,
      moderator: page.moderator,
      /** False while the gate withholds the post (signed out, or no 16+ declaration) or a moderator removed it: the thread must not be sent either. */
      threadVisible: threadVisible(page),
      thread: await loadThread({ page, session, renderer }),
      /** The signed-in person, or null: who may see the author's and moderators' actions. */
      viewerId: session?.view.actorId ?? null,
      thumbnail,
      image,
      /** The times as text in the request's locale, so hydration formats nothing (postTime). */
      published: postTime(locale, view.publishedAt),
      edited: view.editedAt && postTime(locale, view.editedAt),
      domain: view.url ? (URL.parse(view.url)?.hostname.replace(/^www\./, '') ?? null) : null,
    };
  });

/** What the loader hands the page; null from loadPost means there is no such post (404). */
export type PostPageData = NonNullable<Awaited<ReturnType<typeof loadPost>>>;
