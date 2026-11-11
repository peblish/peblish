import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { tabOfKind, blocksPath } from '../-tabs.ts';
import { Notice } from '../../-ui/interim.tsx';
import { blockError } from './errors.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });
type Kind = 'person' | 'community' | 'instance';

/**
 * A form that posts to /settings/blocks and works without JavaScript (the server answers 303).
 * Once hydrated it posts by fetch (Accept: application/json), shows a refusal in place with
 * what was typed kept, and on success goes where the server says (the blocks page's tab, or
 * back to the page a slot sits on) and reloads that page's data. `fields` travel in the form's
 * address (`?intent=add&kind=person`), which the handler reads under the body (-post.ts).
 */
export function BlockForm({
  fields,
  kind,
  className,
  inline = false,
  children,
}: {
  fields: Record<string, string>;
  kind: Kind;
  className?: string;
  /** For a slot beside other row actions: the form flows with them. */
  inline?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslate();
  const router = useRouter();
  const [error, setError] = useState<{ code: string; query: string }>();
  const [busy, setBusy] = useState(false);
  const action = `${blocksPath}?${new URLSearchParams(fields)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget, submitter)) if (typeof value === 'string') body.append(name, value);
    const query = body.get('handle') ?? '';
    const fail = (code: string) => setError({ code, query });
    setBusy(true);
    try {
      const response = await fetch(action, { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return fail('generic');
      if (answer.error) return fail(answer.error);
      setError(undefined);
      // Go to the address the server names, then load its data again: a new address can keep the
      // same loader inputs (/settings/blocks becomes ?tab=people), and the router would keep the
      // list from before the change.
      const here = window.location.pathname + window.location.search;
      if (answer.redirect && answer.redirect.split('#')[0] !== here) await router.navigate({ href: answer.redirect });
      await router.invalidate();
    } catch {
      fail('network');
    } finally {
      setBusy(false);
    }
  }

  const message = error && blockError(error.code, tabOfKind[kind], error.query);
  return (
    <form
      method="post"
      action={action}
      aria-busy={busy}
      className={className}
      // Layout only, inline: a slot sits on pages that do not load the blocks stylesheet.
      style={inline ? { display: 'inline', margin: 0 } : undefined}
      onSubmit={submit}
    >
      {children}
      {message && (
        <Notice tone="danger" role="alert">
          {t('blocks', message.key, message.params)}
        </Notice>
      )}
    </form>
  );
}
