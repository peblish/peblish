import { Button } from '@peblish/ui/components/button';
import { useEffect, useRef } from 'react';

/**
 * Goes first in a form whose Enter key must decide nothing (the Peers controls, the Media
 * decisions, the Bans panels). On Enter a browser submits a form with its first submit button,
 * so two hidden ones come first:
 *
 * - a disabled one: Enter in a text field then submits nothing at all, with scripts on or off;
 * - an enabled one with no intent, for Enter in a date input or on a checkbox, where Chrome skips
 *   a disabled button and takes the next. Hydrated, its submit is cancelled before the form's own
 *   handler sees it, so nothing is sent. Without scripts it posts with no intent, which the server
 *   refuses; where the intent is a hidden field (the Bans panels), `formAction` sends it to a page
 *   that decides nothing instead.
 *
 * Nobody sees them, reaches them with Tab or hears them; the real buttons work as before.
 */
export function NoEnterSubmit({ formAction }: { formAction?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = ref.current;
    const form = button?.form;
    if (!button || !form) return;
    // On the form itself, so it runs before React's handler, which listens at the root.
    const cancel = (event: SubmitEvent) => {
      if (event.submitter !== button) return;
      event.preventDefault();
      event.stopPropagation();
    };
    form.addEventListener('submit', cancel);
    return () => form.removeEventListener('submit', cancel);
  }, []);
  return (
    <>
      <Button type="submit" disabled tabIndex={-1} aria-hidden hidden style={{ display: 'none' }} />
      <Button ref={ref} type="submit" formAction={formAction} tabIndex={-1} aria-hidden hidden style={{ display: 'none' }} />
    </>
  );
}
