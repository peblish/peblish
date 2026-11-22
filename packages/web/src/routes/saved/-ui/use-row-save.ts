import type { PostView } from '@peblish/schema/views';
import type { FeedRowSave } from '@peblish/ui/components/feed-row-actions';
import { useRef, useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { failureKey, requestSave } from './save-request.ts';

/**
 * A feed row menu's Save or Unsave (FeedRowActions' `save`). The row keeps the post's state itself
 * from the moment it changes, and `changed` hands it to the page (the feed writes it into the kept
 * place, so Back shows it). While a request is out the item is disabled and a second choice does
 * nothing; `say` speaks the outcome in the row's polite status, a failure included, which leaves the
 * state as it was. The menu needs scripts, so with them off Save is on the post's own page.
 */
export function useRowSave(post: PostView, say: (message: string) => void, changed: (saved: boolean) => void): FeedRowSave {
  const { t } = useTranslate();
  // The row's own state holds only while the page's data still says what it said then: newer data
  // (the first page reloads on Back, or the feed wrote the change into its place) wins.
  const given = post.saved === true;
  const [mine, setMine] = useState<{ given: boolean; saved: boolean } | null>(null);
  const saved = mine?.given === given ? mine.saved : given;
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const onSave = () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const intent = saved ? 'unsave' : 'save';
    void requestSave(intent, post.id)
      .then((outcome) => {
        if (!outcome.ok) return say(t('saves', failureKey(intent, outcome.reason)));
        setMine({ given, saved: outcome.saved });
        changed(outcome.saved);
        say(t('saves', outcome.saved ? 'status.saved' : 'status.unsaved'));
      })
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };
  return { label: t('saves', saved ? 'action.unsave' : 'action.save'), onSave, pending };
}
