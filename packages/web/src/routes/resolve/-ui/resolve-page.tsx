import { asResolveError, maxLookupLength, type ResolveError } from '@peblish/core/resolve/outcome';
import { parseLookup } from '@peblish/core/resolve/parse';
import { Button } from '@peblish/ui/components/button';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { openInRouter } from '../../../shell/client-links.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { directoryPaths } from '../../../shell/paths.ts';

// /resolve after directory-table.html, in Mux UI: one field for a handle or a link. A GET only shows the
// form (?q= prefills it); the POST does the finding. Without script the answer is a 303 to the
// local page or back here with an error. Hydrated, the form posts by fetch, shows a pending line
// with Cancel, and opens the page it is sent to.

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });
const errorKey = (code: ResolveError | 'network'): MessageKey<'directory'> => `resolve.error.${code}`;

/** The host the pending line names, from what was typed. */
function askedHost(text: string): string | null {
  const lookup = parseLookup(text);
  if (!lookup) return null;
  return lookup.kind === 'handle' ? lookup.host : new URL(lookup.url).host;
}

export function ResolvePage({ signedIn, q, error: initial }: { signedIn: boolean; q: string; error: string | undefined }) {
  const { t } = useTranslate();
  useRouteHydrated();
  return (
    <main className="pb-page dir">
      <div className="dir-toolbar">
        <Text as="h1" variant="heading" size="sm">
          {t('directory', 'resolve.title')}
        </Text>
      </div>
      {signedIn ? (
        <ResolveForm q={q} initial={asResolveError(initial)} />
      ) : (
        <EmptyState
          title={t('directory', 'resolve.signIn.title')}
          action={
            <Link href={`/auth/sign-in?redirect=${encodeURIComponent(directoryPaths.find)}`}>{t('directory', 'resolve.signIn.link')}</Link>
          }
        >
          {t('directory', 'resolve.signIn.body')}
        </EmptyState>
      )}
      <Text as="p" size="sm">
        <Link href={directoryPaths.browse}>{t('directory', 'resolve.browse')}</Link>
      </Text>
    </main>
  );
}

function ResolveForm({ q, initial }: { q: string; initial: ResolveError | undefined }) {
  const { t } = useTranslate();
  const router = useRouter();
  const [error, setError] = useState<ResolveError | 'network' | undefined>(initial);
  const [asking, setAsking] = useState<{ host: string | null } | null>(null);
  const cancel = useRef<AbortController | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('q') ?? '');
    const controller = new AbortController();
    cancel.current = controller;
    setError(undefined);
    setAsking({ host: askedHost(text) });
    try {
      const response = await fetch('/resolve', {
        method: 'POST',
        body: new URLSearchParams({ q: text }),
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return setError('generic');
      if (answer.redirect) return openInRouter(router, answer.redirect);
      setError(asResolveError(answer.error) ?? 'generic');
    } catch {
      // Cancel leaves no message; anything else is the network.
      if (!controller.signal.aborted) setError('network');
    } finally {
      if (cancel.current === controller) setAsking(null);
    }
  }

  return (
    <form className="dir-search dir-resolve" method="post" action={directoryPaths.find} onSubmit={submit} aria-busy={asking !== null}>
      {/* The app's TextField explains an empty or over-long box in the page's language. */}
      <TextField
        className="dir-field"
        label={t('directory', 'resolve.label')}
        name="q"
        defaultValue={q}
        maxLength={maxLookupLength}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        description={t('directory', 'resolve.hint')}
        required
      />
      <div className="dir-buttons">
        <Button type="submit" disabled={asking !== null}>
          {t('directory', 'resolve.submit')}
        </Button>
      </div>
      {asking && (
        <Notice
          role="status"
          className="dir-pending"
          action={
            <Button type="button" variant="neutral" size="sm" onActivate={() => cancel.current?.abort()}>
              {t('directory', 'resolve.cancel')}
            </Button>
          }
        >
          {t('directory', 'resolve.pending', { host: asking.host ?? t('directory', 'resolve.pending.unknown') })}
        </Notice>
      )}
      {error && (
        <Notice
          tone="danger"
          role="alert"
          className="dir-pending"
          action={
            error === 'peer.unreachable' ? (
              <Button type="submit" variant="neutral" size="sm">
                {t('directory', 'resolve.retry')}
              </Button>
            ) : undefined
          }
        >
          {t('directory', errorKey(error))}
        </Notice>
      )}
    </form>
  );
}
