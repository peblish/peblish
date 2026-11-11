import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { tabOfKind, blocksPath } from '../-tabs.ts';
import { Notice } from '@peblish/ui/components/notice';
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
  children,
}: {
  fields: Record<string, string>;
  kind: Kind;
  className?: string;
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
    const here = () => window.location.pathname + window.location.search;
    const from = here();
    setBusy(true);
    try {
      const response = await fetch(action, { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return fail('generic');
      if (answer.error) return fail(answer.error);
      setError(undefined);
      // Go to the address the server names, then load its data again: a new address can keep the
      // same loader inputs (/settings/blocks becomes ?tab=people), and the router would keep the
      // list from before the change. A visitor who moved on while the block was on its way stays
      // where they went; only that page's data reloads, so it reflects the block.
      const moved = here() !== from;
      if (!moved && answer.redirect && answer.redirect.split('#')[0] !== from) await router.navigate({ href: answer.redirect });
      await router.invalidate();
    } catch {
      fail('network');
    } finally {
      setBusy(false);
    }
  }

  const message = error && blockError(error.code, tabOfKind[kind], error.query);
  return (
    <form method="post" action={action} aria-busy={busy} className={className} onSubmit={submit}>
      {children}
      {message && (
        <Notice tone="danger" role="alert">
          {t('blocks', message.key, message.params)}
        </Notice>
      )}
    </form>
  );
}
