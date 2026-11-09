import { readThread, type ThreadComment } from '@peblish/core/comments/read';
import { parseSort, type ThreadSort } from '@peblish/core/comments/sort';
import type { PostPage, Viewer } from '@peblish/core/posts/read';
import type { Uuid } from '@peblish/schema/ids';
import type { SessionView } from '@peblish/schema/session';
import type { ActorRef, CommentView } from '@peblish/schema/views';
import { absoluteTime, compactAge } from '@peblish/ui/components/time';
import { getRequest, getRequestHeader } from '@tanstack/react-start/server';
import { negotiateLocale } from '../../../../i18n/negotiate.ts';
import type { MarkdownRenderer } from '../../../../server/markdown.ts';
import type { SlotViewer } from '../../../-actions/props.ts';

// The thread's data for a page (server only): core's read model, with each comment's text
// rendered by the page's Markdown renderer, and what the viewer can do beside reading. The post
// page's loader (routes/post/-load.ts) and the permalink page call loadThread; the thread
// section calls it again, through a server function (-thread-fn.ts), when the sort changes.

/** What the thread section needs, all JSON. */
export type ThreadData = {
  postId: Uuid;
  postAuthorId: Uuid;
  sort: ThreadSort;
  /** The `after` this was loaded for, as the page asked for it (null for the first page): the section reloads when the address names another. */
  after: string | null;
  /** In display order. contentHtml is the rendered text, null for a tombstone. */
  comments: CommentView[];
  /** Each comment's time as text in the request's locale, so hydration formats nothing (the post page's rule). */
  times: Record<string, { age: string; title: string }>;
  /** The comment a permalink page starts from. */
  focus: { id: Uuid; parentId: Uuid | null } | null;
  /** The cursor for the next page of the siblings this page lists (the top-level comments, or the replies to the focus), or null on the last. */
  next: string | null;
  /** Whether the viewer can reply, or why not. */
  reply: 'yes' | 'sign-in' | 'verify' | 'locked' | 'closed';
  /** The signed-in person, or null. */
  viewerId: Uuid | null;
  /** What the comment rows' action slots (-ui/actions/) need beside each comment; null when signed out, and then they are not drawn. */
  actions: { community: ActorRef; viewer: SlotViewer } | null;
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
  page.gate === 'none' && (!page.view.removed || page.moderator);

/** The `sort` of the page being requested: the document request's query. A server function called from the browser has no page query. */
export const requestedSort = (): ThreadSort => parseSort(URL.parse(getRequest().url)?.searchParams.get('sort'));

/** The `after` cursor of the page being requested, in the same way. */
export const requestedAfter = (): string | null => URL.parse(getRequest().url)?.searchParams.get('after') ?? null;

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
  after?: string | null;
  rootId?: Uuid;
}): Promise<ThreadData | null> {
  const { page, session, renderer, sort = requestedSort(), after = requestedAfter(), rootId } = options;
  if (!threadShown(page)) return null;
  const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
  const thread = await readThread(page.view.id, viewer, { sort, after, rootId: rootId ?? null });
  if (!thread) return null;
  const locale = negotiateLocale(getRequestHeader('accept-language'));
  const now = new Date();
  const focused = thread.focus ? thread.comments.find(({ view }) => view.id === thread.focus?.id) : undefined;
  const mine = focused && viewer?.actorId === focused.view.author.id && !focused.view.deleted && !focused.view.removed;
  return {
    postId: page.view.id,
    postAuthorId: page.view.author.id,
    sort: thread.sort,
    after,
    comments: thread.comments.map((comment) => render(renderer, comment)),
    times: Object.fromEntries(
      thread.comments.map(({ view }) => [
        view.id,
        { age: compactAge(view.publishedAt, now, locale), title: absoluteTime(view.publishedAt, locale) },
      ]),
    ),
    focus: thread.focus,
    next: thread.next,
    reply: replyState(page, session),
    viewerId: viewer?.actorId ?? null,
    actions: viewer
      ? {
          community: page.view.community,
          viewer: { actorId: viewer.actorId, moderator: page.moderator, admin: viewer.siteRole === 'admin' },
        }
      : null,
    removals: thread.comments.flatMap(({ view, removal }) =>
      removal ? [{ id: view.id, handle: view.author.handle, reason: removal.reason }] : [],
    ),
    own: mine && focused.body?.kind === 'markdown' ? { id: focused.view.id, bodyMd: focused.body.source } : null,
  };
}
