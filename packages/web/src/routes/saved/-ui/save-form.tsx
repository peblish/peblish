import { Button } from '@peblish/ui/components/button';
import { BookmarkIcon } from '@peblish/ui/components/icons';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { savedPath } from '../../../shell/paths.ts';
import { failureKey, requestSave, type SaveIntent } from './save-request.ts';

/**
 * Save or Unsave for one post, as a one-button form to POST /saved that works before hydration and
 * without scripts (303 back to `back`). Once hydrated it posts by fetch and stays locked while the
 * request is out (the button is pending, a second press does nothing); a refusal or a failed request
 * shows in place and leaves the post as it was. `onDone` gets the new state.
 *
 * On the post page (a slot beside Report and Block) it is Save, or Unsave once saved, and says what
 * happened in a polite status after it. `inList` is a Saved page row's Unsave: named by the post's
 * title, and silent, since its page moves focus and speaks for it (`onDone`).
 */
export function SaveForm({
  postId,
  title,
  saved,
  back,
  inList = false,
  onDone,
}: {
  postId: string;
  title: string;
  saved: boolean;
  back: string;
  inList?: boolean;
  onDone?: (saved: boolean) => void | Promise<void>;
}) {
  const { t } = useTranslate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [said, setSaid] = useState('');
  const busyRef = useRef(false);
  const intent: SaveIntent = saved ? 'unsave' : 'save';
  const label = t('saves', saved ? 'action.unsave' : 'action.save');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await requestSave(intent, postId);
      if (!outcome.ok) return setError(t('saves', failureKey(intent, outcome.reason)));
      setSaid(t('saves', outcome.saved ? 'status.saved' : 'status.unsaved'));
      await onDone?.(outcome.saved);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form method="post" action={savedPath} aria-busy={busy} className="pb-save" onSubmit={submit}>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="back" value={back} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="pb-save__button"
        pending={busy}
        aria-label={inList ? t('saves', 'action.unsaveOn', { title }) : undefined}
      >
        <BookmarkIcon />
        {label}
      </Button>
      {!inList && (
        <Text role="status" size="sm" color="muted" className="pb-save__status">
          {said}
        </Text>
      )}
      {error && (
        <Notice tone="danger" role="alert" className="pb-save__error">
          {error}
        </Notice>
      )}
    </form>
  );
}
