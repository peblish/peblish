import type { PostView } from '@peblish/schema/views';
import type { FeedRowSave } from '@peblish/ui/components/feed-row-actions';
import { getRouteApi, useRouterState } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { savedPath } from '../../../shell/paths.ts';
import { failureKey, requestSave } from './save-request.ts';

const root = getRouteApi('__root__');

/** What the row itself was told, and for which data: whose page (an actor id, '' signed out) and the post's state then. */
export type RowAnswer = { viewer: string; given: boolean; saved: boolean };

/**
 * The state the row shows: its own answer only while the page's data is still what it was then (the
 * same viewer, the same state of the post), else the data's. So another account signing in through
 * another tab (shell/viewer-sync.ts reloads the data) never sees the first one's save, and newer data
 * that says otherwise wins.
 */
export function shownSaved(mine: RowAnswer | null, now: Omit<RowAnswer, 'saved'>): boolean {
  return mine !== null && mine.viewer === now.viewer && mine.given === now.given ? mine.saved : now.given;
}

/**
 * A feed row menu's Save or Unsave (FeedRowActions' `save`). The row keeps the post's state itself
 * from the moment it changes. While a request is out the item is disabled and a second choice does
 * nothing; `say` speaks the outcome in the row's polite status, a failure included, which leaves the
 * state as it was. Until the page has hydrated, and with scripts off, the menu cannot open: `form` is
 * then a plain POST /saved that comes back to this address (-post.ts, through safeRedirect). Known gap:
 * the feed's kept place (Back) still holds the state the batch loaded with, until the page's data
 * comes again; writing it there belongs to the feed's own reconciliation.
 */
export function useRowSave(post: PostView, say: (message: string) => void): FeedRowSave {
  const { t } = useTranslate();
  const viewer = root.useLoaderData({ select: ({ session }) => session?.actorId ?? '' });
  const here = useRouterState({ select: ({ location }) => location.href });
  const given = post.saved === true;
  const [mine, setMine] = useState<RowAnswer | null>(null);
  const saved = shownSaved(mine, { viewer, given });
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const intent = saved ? 'unsave' : 'save';

  const onSave = () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    void requestSave(intent, post.id)
      .then((outcome) => {
        if (!outcome.ok) return say(t('saves', failureKey(intent, outcome.reason)));
        setMine({ viewer, given, saved: outcome.saved });
        say(t('saves', outcome.saved ? 'status.saved' : 'status.unsaved'));
      })
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };
  return {
    label: t('saves', saved ? 'action.unsave' : 'action.save'),
    onSave,
    pending,
    form: {
      action: savedPath,
      fields: { intent, postId: post.id, back: here },
      label: t('saves', saved ? 'action.unsaveOn' : 'action.saveOn', { title: post.title }),
    },
  };
}
