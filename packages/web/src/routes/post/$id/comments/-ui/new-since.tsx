import { Button } from '@peblish/ui/components/button';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { Text } from '@peblish/ui/components/text';
import type { Uuid } from '@peblish/schema/ids';
import type { CommentView } from '@peblish/schema/views';
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
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
 * visit until it is looked at). A failure is dropped: the next visit records instead.
 */
function useRecordVisit(postId: Uuid, signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return;
    const record = () => void fetch(`${postPath(postId)}/visit`, { method: 'POST', keepalive: true }).catch(() => undefined);
    if (document.visibilityState === 'visible') return record();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      record();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [postId, signedIn]);
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
  if (newCount === 0) return null;
  const label = translatePlural(locale, 'visits', 'jump', newCount);
  const first = comments.find((comment) => comment.isNew);

  // To the next new comment drawn now (one under a folded comment is not), after the last one jumped to, round again at the end.
  function jump(event: MouseEvent<HTMLElement>) {
    const rows = [...document.querySelectorAll<HTMLElement>('.pb-comment[data-new]')];
    if (rows.length === 0) return;
    event.preventDefault();
    const index = (rows.findIndex((row) => row.id === last.current) + 1) % rows.length;
    const row = rows[index];
    if (!row) return;
    last.current = row.id;
    row.tabIndex = -1;
    // Straight there: no smooth travel, whatever the motion setting.
    row.scrollIntoView({ block: 'start' });
    row.focus({ preventScroll: true });
    setSaid(t('visits', 'position', { index: index + 1, total: rows.length }));
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
