import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asPostError, errorKey, type PostError } from './errors.ts';

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });

/**
 * A form that posts to the post page and works without JavaScript (the server answers 303
 * back to the page). Once hydrated it posts by fetch (Accept: application/json), shows a
 * refusal in place and, on success, reloads the page's data instead of navigating.
 */
export function ActionForm({
  action,
  intent,
  className,
  children,
}: {
  action: string;
  intent: 'delete' | 'restore' | 'remove' | 'unremove';
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslate();
  const router = useRouter();
  const [error, setError] = useState<PostError>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget, submitter)) if (typeof value === 'string') body.append(name, value);
    setBusy(true);
    try {
      const response = await fetch(action, { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return setError('generic');
      if (answer.ok) {
        setError(undefined);
        await router.invalidate();
      } else setError(asPostError(answer.error) ?? 'generic');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" action={action} aria-busy={busy} className={className} onSubmit={submit}>
      <input type="hidden" name="intent" value={intent} />
      {children}
      {error && (
        <p className="post-error" role="alert">
          {t('posts', errorKey(error))}
        </p>
      )}
    </form>
  );
}
