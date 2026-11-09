import { readPost, type Viewer } from '@peblish/core/posts/read';
import type { PostView } from '@peblish/schema/views';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';
import { createMarkdownRenderer, siteMarkdown } from '../../server/markdown.ts';

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
    const site = await siteMarkdown();
    const renderer = await createMarkdownRenderer(site);
    const { body } = page;
    const contentHtml =
      body?.kind === 'markdown'
        ? renderer.render(body.source, { idPrefix: page.view.id }).html
        : body
          ? renderer.sanitize(body.html, { baseUrl: body.baseUrl }).html
          : null;
    // Remote media reaches the viewer only through the proxy (decision 5); off this origin and
    // without one, an image shows as the link to it.
    const media = (url: string | null) => {
      if (!url) return null;
      // This instance's own media, and a link preview's proxy URL (lane B2 stores it as thumbnail_url).
      if (/^\/(?!\/)/.test(url) || URL.parse(url)?.origin === site.origin) return url;
      return site.remoteMedia && site.proxy ? site.proxy(url) : null;
    };
    const { view } = page;
    const isImage = view.urlContentType?.startsWith('image/') === true;
    const post: PostView = { ...view, contentHtml };
    return {
      post,
      gate: page.gate,
      moderator: page.moderator,
      /** False while the gate withholds the post (signed out, or no 16+ declaration): the thread must not be sent either. */
      threadVisible: page.gate === 'none' || page.gate === 'blur',
      /** The signed-in person, or null: who may see the author's and moderators' actions. */
      viewerId: session?.view.actorId ?? null,
      thumbnail: media(view.thumbnailUrl),
      image: isImage ? media(view.url) : null,
      domain: view.url ? (URL.parse(view.url)?.hostname.replace(/^www\./, '') ?? null) : null,
    };
  });

/** What the loader hands the page; null from loadPost means there is no such post (404). */
export type PostPageData = NonNullable<Awaited<ReturnType<typeof loadPost>>>;
