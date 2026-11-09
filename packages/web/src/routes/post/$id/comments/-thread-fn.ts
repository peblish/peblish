import { readPost, type Viewer } from '@peblish/core/posts/read';
import { ThreadSortParam } from '@peblish/core/comments/sort';
import { Uuid } from '@peblish/schema/ids';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../../../server/auth.ts';
import { createMarkdownRenderer, siteMarkdown } from '../../../../server/markdown.ts';
import { loadThread, threadShown } from './-thread.ts';

/**
 * A post's thread in the sort asked for, for the thread section once the page is hydrated
 * (the page's own loader sends the sort of the document request). Null when there is no such
 * post or the thread is not shown to this viewer.
 */
export const loadThreadFn = createServerFn({ method: 'GET' })
  .validator(type({ postId: Uuid, sort: ThreadSortParam, 'after?': 'string', 'rootId?': Uuid }))
  .handler(async ({ data }) => {
    const session = await pageSession();
    const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
    const page = await readPost(data.postId, viewer);
    if (!page) return null;
    const renderer = await createMarkdownRenderer(await siteMarkdown());
    return loadThread({
      page,
      session,
      renderer,
      sort: data.sort,
      after: data.after ?? null,
      ...(data.rootId && { rootId: data.rootId }),
    });
  });

/**
 * What the permalink page (/post/<id>/comments/<commentId>) shows: the post's title and
 * community for the way back, and the thread under the comment. `thread` is null while the
 * post is withheld by the sensitive-content gate, and the whole answer is null when the post or
 * the comment does not exist.
 */
export const loadPermalinkFn = createServerFn({ method: 'GET' })
  .validator(type({ postId: 'string', commentId: 'string', sort: ThreadSortParam, 'after?': 'string' }))
  .handler(async ({ data }) => {
    if (!Uuid.allows(data.postId) || !Uuid.allows(data.commentId)) return null;
    const session = await pageSession();
    const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
    const page = await readPost(data.postId, viewer);
    if (!page) return null;
    const renderer = await createMarkdownRenderer(await siteMarkdown());
    // Under a removed post the comments are not shown, and the page is simply not there.
    const gated = page.gate !== 'none';
    if (!gated && !threadShown(page)) return null;
    const thread = await loadThread({ page, session, renderer, sort: data.sort, after: data.after ?? null, rootId: data.commentId });
    if (!gated && !thread) return null;
    return {
      gate: page.gate,
      postTitle: page.view.title,
      communityHandle: page.view.community.handle,
      thread,
    };
  });
