import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { Button } from '@peblish/ui/components/button';
import { Text } from '@peblish/ui/components/text';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asPostError, errorKey, type PostError } from './errors.ts';

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });

/**
 * A one-button form that posts to the post page and works without JavaScript (the server
 * answers 303 back to the page); the intent rides on the submit button. Once hydrated it posts by fetch (Accept: application/json), shows a
 * refusal in place and, on success, reloads the page's data instead of navigating.
 */
export function ActionForm({
  action,
  intent,
  label,
  className,
}: {
  action: string;
  intent: 'delete' | 'restore';
  label: string;
  className?: string;
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
      <Button
        type="submit"
        name="intent"
        value={intent}
        variant={intent === 'delete' ? 'danger-neutral' : 'neutral'}
        size="sm"
        pending={busy}
      >
        {label}
      </Button>
      {error && (
        <Text as="p" role="alert" className="post-error">
          {t('posts', errorKey(error))}
        </Text>
      )}
    </form>
  );
}
