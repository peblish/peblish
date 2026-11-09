import { readThread, type ThreadComment } from '@peblish/core/comments/read';
import { parseSort, type ThreadSort } from '@peblish/core/comments/sort';
import type { PostPage, Viewer } from '@peblish/core/posts/read';
import type { Uuid } from '@peblish/schema/ids';
import type { SessionView } from '@peblish/schema/session';
import type { CommentView } from '@peblish/schema/views';
import { getRequest } from '@tanstack/react-start/server';
import type { MarkdownRenderer } from '../../../../server/markdown.ts';

// The thread's data for a page (server only): core's read model, with each comment's text
// rendered by the page's Markdown renderer, and what the viewer can do beside reading. The post
// page's loader (routes/post/-load.ts) and the permalink page call loadThread; the thread
// section calls it again, through a server function (-thread-fn.ts), when the sort changes.

/** What the thread section needs, all JSON. */
export type ThreadData = {
  postId: Uuid;
  postAuthorId: Uuid;
  sort: ThreadSort;
  /** In display order. contentHtml is the rendered text, null for a tombstone. */
  comments: CommentView[];
  /** The comment a permalink page starts from. */
  focus: { id: Uuid; parentId: Uuid | null } | null;
  /** The thread has more comments than a page holds. */
  truncated: boolean;
  /** Whether the viewer can reply, or why not. */
  reply: 'yes' | 'sign-in' | 'verify' | 'locked' | 'closed';
  /** The signed-in person, or null. */
  viewerId: Uuid | null;
  /** For a moderator: the removed comments, with the modlog reason. */
  removals: { id: Uuid; handle: string; reason: string | null }[];
  /** The focus comment's Markdown, when the viewer wrote it and can still edit it. */
  own: { id: Uuid; bodyMd: string } | null;
};

/**
 * Whether the post's thread is shown at all: the sensitive-content gate shows the post, and a
 * post a moderator removed keeps its comments from everyone but the moderators and site admins.
 * The same rule as the post page's data.threadVisible.
 */
export const threadShown = (page: Pick<PostPage, 'gate' | 'moderator'> & { view: Pick<PostPage['view'], 'removed'> }) =>
  (page.gate === 'none' || page.gate === 'blur') && (!page.view.removed || page.moderator);

/** The `sort` of the page being requested: the document request's query. A server function called from the browser has no page query. */
export const requestedSort = (): ThreadSort => parseSort(URL.parse(getRequest().url)?.searchParams.get('sort'));

function render(renderer: MarkdownRenderer, { view, body }: ThreadComment): CommentView {
  const contentHtml =
    body?.kind === 'markdown'
      ? renderer.render(body.source, { idPrefix: view.id }).html
      : body
        ? renderer.sanitize(body.html, { baseUrl: body.baseUrl }).html
        : null;
  return { ...view, contentHtml };
}

function replyState(page: PostPage, session: { view: SessionView } | null): ThreadData['reply'] {
  // What closes the thread comes first: signing in would not help.
  if (page.view.locked) return 'locked';
  if (page.view.deleted || page.view.removed) return 'closed';
  if (!session) return 'sign-in';
  return session.view.emailVerified ? 'yes' : 'verify';
}

/**
 * The thread of the post `page` describes, or the part under `rootId`. Null when the thread is
 * not shown (the gate) or `rootId` is not a comment of this post.
 */
export async function loadThread(options: {
  page: PostPage;
  session: { view: SessionView } | null;
  renderer: MarkdownRenderer;
  sort?: ThreadSort;
  rootId?: Uuid;
}): Promise<ThreadData | null> {
  const { page, session, renderer, sort = requestedSort(), rootId } = options;
  if (!threadShown(page)) return null;
  const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
  const thread = await readThread(page.view.id, viewer, { sort, rootId: rootId ?? null });
  if (!thread) return null;
  const focused = thread.focus ? thread.comments.find(({ view }) => view.id === thread.focus?.id) : undefined;
  const mine = focused && viewer?.actorId === focused.view.author.id && !focused.view.deleted && !focused.view.removed;
  return {
    postId: page.view.id,
    postAuthorId: page.view.author.id,
    sort: thread.sort,
    comments: thread.comments.map((comment) => render(renderer, comment)),
    focus: thread.focus,
    truncated: thread.truncated,
    reply: replyState(page, session),
    viewerId: viewer?.actorId ?? null,
    removals: thread.comments.flatMap(({ view, removal }) =>
      removal ? [{ id: view.id, handle: view.author.handle, reason: removal.reason }] : [],
    ),
    own: mine && focused.body?.kind === 'markdown' ? { id: focused.view.id, bodyMd: focused.body.source } : null,
  };
}
