import { readPost, type Viewer } from '@peblish/core/posts/read';
import type { PostView } from '@peblish/schema/views';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';
import { createMarkdownRenderer } from '../../server/markdown.ts';
import { postMedia, threadVisible } from './-page-data.ts';

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
    const post: PostView = { ...view, contentHtml };
    return {
      post,
      gate: page.gate,
      moderator: page.moderator,
      /** False while the gate withholds the post (signed out, or no 16+ declaration) or a moderator removed it: the thread must not be sent either. */
      threadVisible: threadVisible(page),
      /** The signed-in person, or null: who may see the author's and moderators' actions. */
      viewerId: session?.view.actorId ?? null,
      thumbnail,
      image,
      domain: view.url ? (URL.parse(view.url)?.hostname.replace(/^www\./, '') ?? null) : null,
    };
  });

/** What the loader hands the page; null from loadPost means there is no such post (404). */
export type PostPageData = NonNullable<Awaited<ReturnType<typeof loadPost>>>;
