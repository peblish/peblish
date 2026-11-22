import { Button } from '@peblish/ui/components/button';
import { Text } from '@peblish/ui/components/text';
import type { FormEvent } from 'react';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { inboxAction, type InboxSearch } from '../-search.ts';

// What Mark all read leaves on the page: "Marked 3 as read." with an Undo, then, once undone, how
// many are unread again. The vendored Mux UI has no toast with an action, so this is the mock's
// in-page fallback: a status row under the title. It reads the page's address (`marked`, `batch`,
// `restored`, which -form.ts's answer puts there), so it is the same with scripts and without.
// The region is always there, so a change in it is announced; empty, it takes no room.

export const undoButtonId = 'inbox-undo';

export function MarkedStatus({
  search,
  page,
  pending = false,
  onUndo,
}: {
  search: InboxSearch;
  page: InboxSearch;
  /** The Undo is on its way. */
  pending?: boolean;
  /** Hydrated, Undo posts by fetch; without it the browser posts the form. */
  onUndo?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t, locale } = useTranslate();
  const { marked, batch, restored } = search;
  return (
    <Text as="div" size="sm" role="status" className="pb-notice-status">
      {marked && batch ? (
        <>
          <Text size="sm">{translatePlural(locale, 'notifications', 'undo.marked', marked)}</Text>
          <form method="post" action={inboxAction({ intent: 'undo_read_all', batch: String(batch) }, page)} onSubmit={onUndo}>
            <Button
              id={undoButtonId}
              type="submit"
              variant="ghost"
              size="sm"
              pending={pending}
              aria-label={t('notifications', 'undo.name', { count: marked })}
            >
              {t('notifications', 'undo')}
            </Button>
          </form>
        </>
      ) : (
        restored && <Text size="sm">{translatePlural(locale, 'notifications', 'undo.restored', restored)}</Text>
      )}
    </Text>
  );
}
