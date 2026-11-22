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
 * Records the visit once the page is on screen: after hydration (so a prefetch, a preload or a
 * page without scripts records nothing), in its own POST to /post/<id>/visit (so it cannot fail
 * or slow the page), and only once the tab is visible (a page opened in the background is not a
 * visit until it is looked at). A page brought forward from the background reloads its data first,
 * so the visit counts as seen only what the reader is then shown, not a reply that arrived while
 * it waited. A failure is dropped: the next visit records instead.
 */
function useRecordVisit(postId: Uuid, signedIn: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const record = () => void fetch(`${postPath(postId)}/visit`, { method: 'POST', keepalive: true }).catch(() => undefined);
    if (document.visibilityState === 'visible') return record();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      // A failed reload still records: the page shows what it had, as a visible tab's would.
      void router
        .invalidate()
        .catch(() => undefined)
        .then(() => live && record());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
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
}: {
  postId: Uuid;
  viewerId: Uuid | null;
  newCount: number;
  comments: readonly CommentView[];
}) {
  useRecordVisit(postId, viewerId !== null);
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
    const row = document.getElementById(`comment-${target.id}`);
    if (!row) return;
    last.current = target.id;
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
