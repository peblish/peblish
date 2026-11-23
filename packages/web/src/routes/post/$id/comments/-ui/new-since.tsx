import { Button } from '@peblish/ui/components/button';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { Text } from '@peblish/ui/components/text';
import type { Uuid } from '@peblish/schema/ids';
import type { CommentView } from '@peblish/schema/views';
import { useRouter } from '@tanstack/react-router';
import { setFold } from '@peblish/ui/components/comment-folds.ts';
import { buildCommentTree, type CommentNode } from '@peblish/ui/components/comment-tree.ts';
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { translatePlural } from '../../../../../i18n/translate.ts';
import { useTranslate } from '../../../../../i18n/use-translate.ts';
import { postPath } from '../../../../../shell/paths.ts';
import newSinceCss from './new-since.css?url';

// "New since your last visit" on a post's thread (core visits/): it records the visit, and when
// comments arrived since the one before, says how many and jumps from one to the next. The
// rows carry their own "New" mark (CommentThread). The post page mounts it; a permalink page
// does not, so opening one branch never counts as having seen the rest of the thread.

/**
 * Whether this document has been out of sight since it loaded: a tab opened in the background, or one
 * brought forward before the page hydrated (Chromium lists the document's visibility changes; elsewhere
 * a tab in front by the time scripts run counts as watched).
 */
function wasHidden(): boolean {
  if (document.visibilityState !== 'visible') return true;
  if (!PerformanceObserver.supportedEntryTypes.includes('visibility-state')) return false;
  return performance.getEntriesByType('visibility-state').some((entry) => entry.name === 'hidden');
}

/**
 * Records the visit once the page is on screen: after hydration (so a prefetch, a preload or a
 * page without scripts records nothing), in its own POST to /post/<id>/visit (so it cannot fail
 * or slow the page), and only once the tab is visible (a page opened in the background is not a
 * visit until it is looked at).
 *
 * A page that has been out of sight is reloaded first, by the router's own reload of the post's
 * route: the loader that drew it draws it again for the same address (sort and page), so a post
 * gone or gated since shows what a fresh load would, and the heading, the rail and the thread
 * come from one answer. The visit goes once the thread that reload answered is drawn (`drawnAt`,
 * the server's clock of the thread on screen, against the router's latest answer), so it counts
 * as seen what the reader is shown, never a reply that arrived meanwhile. Each time the tab comes
 * forward is a generation; hiding it, or coming forward again, ends the one before, which then
 * records nothing, and a new generation's reload waits for the one still out (the router would
 * join it, and hand back an answer from before) and then asks afresh. The reader's own reply
 * reloads the route too: the latest answer, once drawn, settles the waiting visit.
 * A reload is asked only once the server answers at all (/healthz), because a router reload
 * that fails puts its error page in place of the thread: offline, the page stays as it was, and
 * nothing is recorded until the tab comes forward again. A failed record is dropped: the next
 * visit records instead.
 */
function useRecordVisit(postId: Uuid, signedIn: boolean, drawnAt: string | undefined) {
  const router = useRouter();
  // The server's clock of the thread on screen, written after each commit.
  const drawn = useRef(drawnAt);
  useEffect(() => {
    drawn.current = drawnAt;
  }, [drawnAt]);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    let generation = 0;
    const visible = () => document.visibilityState === 'visible';
    const record = () => void fetch(`${postPath(postId)}/visit`, { method: 'POST', keepalive: true }).catch(() => undefined);
    // The router's match of the post page, and the server's clock of the thread in its latest answer.
    const page = () => router.state.matches.find(({ routeId }) => routeId === '/post/$id/');
    const answered = () => {
      const data: unknown = page()?.loaderData;
      return data && typeof data === 'object' && 'thread' in data ? (data.thread as { now?: string } | null)?.now : undefined;
    };
    // Until nothing is out for the post page any more (the reader's own reply reloads it too) and its latest answer is drawn.
    const settled = async (mine: number) => {
      while (current(mine) && (page()?.isFetching || router.state.status !== 'idle' || drawn.current !== answered()))
        await new Promise((done) => setTimeout(done, 50));
    };
    let out: Promise<unknown> = Promise.resolve();
    const current = (mine: number) => live && mine === generation && visible();
    const forward = async () => {
      const mine = ++generation;
      const answers = await fetch('/healthz', { cache: 'no-store' }).then(
        (response) => response.ok,
        () => false,
      );
      if (!answers || !current(mine)) return;
      await out;
      if (!current(mine)) return;
      // `sync`: the answer is awaited (and drawn on its arrival), not fetched in the background after it.
      const reload = router.invalidate({ filter: (match) => match.routeId === '/post/$id/', sync: true }).catch(() => undefined);
      out = reload;
      await reload;
      if (!current(mine)) return;
      // A newer reload (the reader's own reply) may have taken this one's place: its answer, once drawn, settles the visit.
      await settled(mine);
      // A reload that failed after the probe leaves the router's error page: nothing was seen, nothing is recorded.
      if (!current(mine) || page()?.status !== 'success') return;
      document.removeEventListener('visibilitychange', onChange);
      record();
    };
    const onChange = () => {
      if (visible()) void forward();
      else generation += 1;
    };
    if (!wasHidden()) return record();
    document.addEventListener('visibilitychange', onChange);
    if (visible()) void forward();
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onChange);
    };
  }, [postId, signedIn, router]);
}

/** The new comments in the order the thread draws them (the tree's, depth first). */
function newInOrder(comments: readonly CommentView[]): CommentView[] {
  const found: CommentView[] = [];
  const walk = (nodes: readonly CommentNode[]) => {
    for (const node of nodes) {
      if (node.comment.isNew && !node.comment.deleted && !node.comment.removed) found.push(node.comment);
      walk(node.children);
    }
  };
  walk(buildCommentTree(comments));
  return found;
}

export function NewSince({
  postId,
  viewerId,
  newCount,
  comments,
  drawnAt,
}: {
  postId: Uuid;
  viewerId: Uuid | null;
  newCount: number;
  comments: readonly CommentView[];
  /** The server's clock of the thread snapshot drawn (ThreadData.now); without it, a tab that was out of sight records nothing. */
  drawnAt?: string;
}) {
  useRecordVisit(postId, viewerId !== null, drawnAt);
  const { t, locale } = useTranslate();
  const [said, setSaid] = useState('');
  const last = useRef<string | null>(null);
  const offPage = useId();
  const order = useMemo(() => newInOrder(comments), [comments]);
  const parents = useMemo(() => new Map(comments.map((comment) => [comment.id, comment.parentId])), [comments]);
  if (newCount === 0) return null;
  const label = translatePlural(locale, 'visits', 'jump', newCount);
  const first = order[0];

  // To the next new comment on this page, after the last one jumped to, round again at the end. A comment it
  // lies under that is folded (for its low score, or by the reader) is opened first, so focus lands on a
  // drawn row before the position is said.
  function jump(event: MouseEvent<HTMLElement>) {
    if (order.length === 0) return;
    event.preventDefault();
    const index = (order.findIndex((comment) => comment.id === last.current) + 1) % order.length;
    const target = order[index];
    if (!target) return;
    flushSync(() => {
      for (let id = parents.get(target.id); id; id = parents.get(id)) setFold(id, false);
    });
    // Past it next time even when it cannot be drawn, so the jump never sticks on one comment.
    last.current = target.id;
    const row = document.getElementById(`comment-${target.id}`);
    if (!row) return;
    row.tabIndex = -1;
    // Straight there: no smooth travel, whatever the motion setting.
    row.scrollIntoView({ block: 'start' });
    row.focus({ preventScroll: true });
    setSaid(t('visits', 'position', { index: index + 1, total: order.length }));
  }

  return (
    <>
      <link rel="stylesheet" href={newSinceCss} />
      {first ? (
        // A hash link to the first new comment, which works before hydration; once scripts run, the click handler takes it over.
        <ButtonLink href={`#comment-${first.id}`} onClick={jump} size="sm" variant="neutral" className="th-new">
          {label}
        </ButtonLink>
      ) : (
        // The new comments are all on other pages of the thread.
        <>
          <Button size="sm" variant="neutral" disabled aria-describedby={offPage} className="th-new">
            {label}
          </Button>
          <Text id={offPage} className="pb-sr">
            {t('visits', 'offPage')}
          </Text>
        </>
      )}
      <Text role="status" className="pb-sr">
        {said}
      </Text>
    </>
  );
}
