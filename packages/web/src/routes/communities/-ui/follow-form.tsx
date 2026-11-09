import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, type FormEvent, type ReactNode } from 'react';
import { asDirectoryError, type DirectoryError } from './errors.ts';

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });

/**
 * A Join or Leave button as a form that posts to /communities/follow and works without
 * JavaScript (the server answers 303 back to `next`). Once hydrated it posts by fetch
 * (Accept: application/json), tells the page about a refusal, and on success reloads the
 * page's data instead of navigating.
 */
export function FollowForm({
  community,
  intent,
  next,
  onError,
  children,
}: {
  community: string;
  intent: 'join' | 'leave';
  next: string;
  onError: (error: DirectoryError | undefined) => void;
  children: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) if (typeof value === 'string') body.append(name, value);
    setBusy(true);
    try {
      const response = await fetch('/communities/follow', { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return onError('generic');
      if (answer.ok) {
        onError(undefined);
        await router.invalidate();
      } else onError(asDirectoryError(answer.error) ?? 'generic');
    } catch {
      onError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" action="/communities/follow" aria-busy={busy} onSubmit={submit}>
      <input type="hidden" name="community" value={community} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="next" value={next} />
      {children}
    </form>
  );
}
