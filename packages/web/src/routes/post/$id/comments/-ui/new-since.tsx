import { Button } from '@peblish/ui/components/button';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { Text } from '@peblish/ui/components/text';
import type { Uuid } from '@peblish/schema/ids';
import type { CommentView } from '@peblish/schema/views';
import { setFold } from '@peblish/ui/components/comment-folds.ts';
import { buildCommentTree, type CommentNode } from '@peblish/ui/components/comment-tree.ts';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
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
 * visit until it is looked at). A page that has been out of sight first has the thread section
 * reload the very page on screen (`refresh`: its sort and cursor), so the visit counts as seen only
 * what the reader is then shown, not a reply that arrived while it waited; the visit is recorded
 * once that page is drawn, if the tab is still in front. A failed reload leaves the thread as it
 * was and records nothing (the next time the tab comes forward tries again). A failed record is
 * dropped too: the next visit records instead.
 */
function useRecordVisit(postId: Uuid, signedIn: boolean, refresh: (() => Promise<boolean>) | undefined) {
  const latest = useRef(refresh);
  useLayoutEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const visible = () => document.visibilityState === 'visible';
    const record = () => void fetch(`${postPath(postId)}/visit`, { method: 'POST', keepalive: true }).catch(() => undefined);
    const forward = async () => {
      const shown = (await latest.current?.()) ?? false;
      if (!live) return;
      if (shown && visible()) record();
      else wait();
    };
    const onVisible = () => {
      if (!visible()) return;
      document.removeEventListener('visibilitychange', onVisible);
      void forward();
    };
    const wait = () => document.addEventListener('visibilitychange', onVisible);
    if (!wasHidden()) record();
    else if (visible()) void forward();
    else wait();
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [postId, signedIn]);
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
  refresh,
}: {
  postId: Uuid;
  viewerId: Uuid | null;
  newCount: number;
  comments: readonly CommentView[];
  /** Reloads the thread page on screen; true once it is drawn. Without it, a tab that was out of sight records nothing. */
  refresh?: () => Promise<boolean>;
}) {
  useRecordVisit(postId, viewerId !== null, refresh);
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
