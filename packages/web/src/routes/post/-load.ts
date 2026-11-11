import { readPost, type Viewer } from '@peblish/core/posts/read';
import type { PostView } from '@peblish/schema/views';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { negotiateLocale } from '../../i18n/negotiate.ts';
import { pageSession } from '../../server/auth.ts';
import { createMarkdownRenderer } from '../../server/markdown.ts';
import { postPath } from '../../shell/paths.ts';
import { gateData, requestNsfw } from '../c/-gate.ts';
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
    const page = await readPost(data.id, viewer, undefined, requestNsfw());
    if (!page) return null;
    // A flagged post that is not shown to this viewer sends the gate and nothing about the post (not even its community's name).
    if (page.gate !== 'none')
      return gateData({ subject: 'post', gate: page.gate, handle: page.view.community.handle, back: postPath(page.view.id) });
    const renderer = await createMarkdownRenderer();
    const { body } = page;
    const contentHtml =
      body?.kind === 'markdown'
        ? renderer.render(body.source, { idPrefix: page.view.id, content: { kind: 'post', id: page.view.id, apId: page.view.apId } }).html
        : body
          ? renderer.sanitize(body.html, { baseUrl: body.baseUrl, content: { kind: 'post', id: page.view.id, apId: page.view.apId } }).html
          : null;
    const { view } = page;
    const { thumbnail, image } = postMedia(view, renderer);
    const locale = negotiateLocale(getRequestHeader('accept-language'));
    // The page draws `thumbnail` (through the proxy rule); the picture's own address stays out of the page data.
    const post: PostView = { ...view, thumbnailUrl: null, contentHtml };
    return {
      kind: 'post' as const,
      post,
      moderator: page.moderator,
      /** False while a moderator removed the post: the thread must not be sent either (the gate sends no post at all). */
      threadVisible: threadVisible(page),
      thread: await loadThread({ page, session, renderer }),
      /** The signed-in person, or null: who may see the author's actions and the action slots. */
      viewerId: session?.view.actorId ?? null,
      /** A site admin with two-factor on, for the action slots. */
      viewerAdmin: session?.view.siteRole === 'admin',
      thumbnail,
      image,
      /** The server's clock: the post's age is counted from it, so hydration prints what the server did. */
      now: new Date().toISOString(),
      /** The edit time as text in the request's locale, so hydration formats nothing (postTime). */
      edited: view.editedAt && postTime(locale, view.editedAt),
      domain: view.url ? (URL.parse(view.url)?.hostname.replace(/^www\./, '') ?? null) : null,
    };
  });

/** What the loader hands the page; null from loadPost means there is no such post (404). `kind: 'gate'` is the NSFW gate in place of the post. */
export type PostPageData = NonNullable<Awaited<ReturnType<typeof loadPost>>>;
