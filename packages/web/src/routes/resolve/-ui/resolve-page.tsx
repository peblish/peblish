import { asResolveError, maxLookupLength, type ResolveError } from '@peblish/core/resolve/outcome';
import { parseLookup } from '@peblish/core/resolve/parse';
import { Button } from '@peblish/ui/components/button';
import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { openInRouter } from '../../../shell/client-links.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { directoryPaths } from '../../../shell/paths.ts';

// /resolve after directory-table.html: one field for a handle or a link. A GET only shows the
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
        <h1>{t('directory', 'resolve.title')}</h1>
      </div>
      {signedIn ? (
        <ResolveForm q={q} initial={asResolveError(initial)} />
      ) : (
        <section className="dir-empty">
          <h2>{t('directory', 'resolve.signIn.title')}</h2>
          <p>{t('directory', 'resolve.signIn.body')}</p>
          <p>
            <a href={`/auth/sign-in?redirect=${encodeURIComponent(directoryPaths.find)}`}>{t('directory', 'resolve.signIn.link')}</a>
          </p>
        </section>
      )}
      <p className="dir-hint">
        <a href={directoryPaths.browse}>{t('directory', 'resolve.browse')}</a>
      </p>
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
      <div className="dir-field">
        <label htmlFor="resolve-q">{t('directory', 'resolve.label')}</label>
        <input
          id="resolve-q"
          type="text"
          name="q"
          defaultValue={q}
          maxLength={maxLookupLength}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="resolve-hint"
        />
        <span id="resolve-hint" className="dir-muted">
          {t('directory', 'resolve.hint')}
        </span>
      </div>
      <div className="dir-buttons">
        <Button type="submit" disabled={asking !== null}>
          {t('directory', 'resolve.submit')}
        </Button>
      </div>
      {asking && (
        <p className="dir-pending" role="status">
          {t('directory', 'resolve.pending', { host: asking.host ?? t('directory', 'resolve.pending.unknown') })}{' '}
          <Button type="button" onActivate={() => cancel.current?.abort()}>
            {t('directory', 'resolve.cancel')}
          </Button>
        </p>
      )}
      {error && (
        <p className="dir-error" role="alert">
          {t('directory', errorKey(error))}{' '}
          {error === 'peer.unreachable' && <Button type="submit">{t('directory', 'resolve.retry')}</Button>}
        </p>
      )}
    </form>
  );
}
