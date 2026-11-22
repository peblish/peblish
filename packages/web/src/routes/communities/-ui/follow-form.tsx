import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import type { FormEvent, ReactNode } from 'react';
import { asDirectoryError, type DirectoryError } from './errors.ts';

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });

/**
 * A Join or Leave button as a form that posts to /communities/follow and works without
 * JavaScript (the server answers 303 back to `next`). Once hydrated it posts by fetch
 * (Accept: application/json), tells the page about a refusal, and on success reloads the
 * page's data instead of navigating. The page keeps `busy`, so a post on its way outlives a
 * remount (the directory's switch between List and Cards); while busy a press sends nothing.
 */
export function FollowForm({
  community,
  intent,
  next,
  busy,
  onBusy,
  onError,
  children,
}: {
  community: string;
  intent: 'join' | 'leave';
  next: string;
  busy: boolean;
  /** Told when a post starts and ends. */
  onBusy: (busy: boolean) => void;
  onError: (error: DirectoryError | undefined) => void;
  children: ReactNode;
}) {
  const router = useRouter();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) if (typeof value === 'string') body.append(name, value);
    onBusy(true);
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
      onBusy(false);
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
