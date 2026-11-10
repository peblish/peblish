import { updatePeerAs } from '@peblish/core/peers/service';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, principalOf, privateResponses, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { adminPaths } from '../../../shell/paths.ts';
import { answer } from '../../post/-form.ts';
import { authHead, AuthPage, useDate } from '../../auth/-ui/page.tsx';
import { errorKey } from '../../modlog/-ui/panels.tsx';
import { Denial } from '../-denial.tsx';
import { changes, hostFrom, Body } from './-act.ts';
import { loadPeers } from './-load.ts';

// /admin/peers: the Peers tab (R2 pick admin-tabs). Every instance we know of, with what this
// server does about it: its media (quarantined until approved, approved, purged), its inbox
// (paused: the peer retries), blocked (everything stops). A new peer starts with its media
// quarantined: its text shows, its images do not. Trusted-for-modlog is the settings tab's.

const Search = (raw: Record<string, unknown>): { error?: string } => (typeof raw.error === 'string' ? { error: raw.error } : {});

export const Route = createFileRoute('/admin/peers/')({
  validateSearch: Search,
  loader: () => loadPeers(),
  head: authHead,
  component: Peers,
  server: {
    middleware: [privateResponses],
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const back = adminPaths.peers;
        if (!session) return answer(request, cookies, { ok: false, reason: 'auth.required' }, back);
        const body = Body(await readForm(request));
        if (body instanceof type.errors) return answer(request, cookies, { ok: false, reason: 'target.not_found' }, back);
        const reason = body.reason?.trim();
        const result = await updatePeerAs(principalOf(session.view), hostFrom(body.domain), {
          ...changes[body.intent],
          ...(reason ? { reason: reason.slice(0, 10_000) } : {}),
        });
        return answer(request, cookies, result.ok ? { ok: true } : { ok: false, reason: result.reason }, back);
      },
    },
  },
});

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });

/** A form that posts to this page and works without JavaScript (303 back); hydrated it posts by fetch and shows a refusal in place. */
function PeerForm({
  initialError,
  className,
  children,
}: {
  initialError?: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslate();
  const router = useRouter();
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget, submitter)) if (typeof value === 'string') body.append(name, value);
    setBusy(true);
    try {
      const response = await fetch(adminPaths.peers, { method: 'POST', body, headers: { accept: 'application/json' } });
      const parsed = Answer(await response.json());
      if (parsed instanceof type.errors) return setError('generic');
      if (parsed.ok) {
        setError(undefined);
        await router.invalidate();
      } else setError(parsed.error ?? 'generic');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form method="post" action={adminPaths.peers} aria-busy={busy} className={className} onSubmit={submit}>
      {children}
      {error && (
        <p className="auth-error" role="alert">
          {t('modlog', errorKey(error))}
        </p>
      )}
    </form>
  );
}

function Peers() {
  const { t, locale } = useTranslate();
  const data = Route.useLoaderData();
  const { error } = Route.useSearch();
  const date = useDate();
  const number = new Intl.NumberFormat(locale);
  useRouteHydrated();
  if (data.access !== 'ok')
    return (
      <AuthPage>
        <h1>{t('peers', 'title')}</h1>
        <Denial
          access={data.access}
          copy={{
            needsTwoFactor: t('peers', 'needsTwoFactor'),
            securityLink: t('peers', 'securityLink'),
            notAdmin: t('peers', 'notAdmin'),
          }}
        />
      </AuthPage>
    );
  return (
    <AuthPage wide>
      <h1>{t('peers', 'title')}</h1>
      <p className="muted">{t('peers', 'intro')}</p>
      <PeerForm initialError={error} className="peers-add">
        <div className="fld">
          <label htmlFor="peer-host">{t('peers', 'blockHost')}</label>
          <input id="peer-host" name="domain" placeholder={t('peers', 'hostPlaceholder')} required />
        </div>
        <div className="fld">
          <label htmlFor="peer-host-reason">{t('peers', 'reason')}</label>
          <input id="peer-host-reason" name="reason" maxLength={10000} />
        </div>
        <Button type="submit" name="intent" value="block" variant="primary">
          {t('peers', 'block')}
        </Button>
      </PeerForm>
      {data.peers.length === 0 ? (
        <p className="muted" data-testid="peers-empty">
          {t('peers', 'empty')}
        </p>
      ) : (
        <table className="invites" data-testid="peers-table">
          <thead>
            <tr>
              <th>{t('peers', 'colHost')}</th>
              <th>{t('peers', 'colSoftware')}</th>
              <th>{t('peers', 'colPeople')}</th>
              <th>{t('peers', 'colHeard')}</th>
              <th>{t('peers', 'colState')}</th>
              <th>{t('peers', 'colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {data.peers.map((peer) => (
              <tr key={peer.instanceId} data-testid="peer-row" data-domain={peer.domain}>
                <td data-label={t('peers', 'colHost')}>{peer.domain}</td>
                <td data-label={t('peers', 'colSoftware')}>{peer.software ?? <span className="muted">{t('peers', 'unknown')}</span>}</td>
                <td data-label={t('peers', 'colPeople')}>{number.format(peer.people)}</td>
                <td data-label={t('peers', 'colHeard')}>
                  {peer.lastHeardAt ? date(peer.lastHeardAt) : <span className="muted">{t('peers', 'never')}</span>}
                </td>
                <td data-label={t('peers', 'colState')}>
                  <span className={`status ${peer.media === 'approved' ? 'ok-t' : 'warn-t'}`} data-testid="peer-media">
                    {t('peers', `media.${peer.media}`)}
                  </span>
                  {peer.inboxPaused && <span className="status warn-t"> {t('peers', 'state.paused')}</span>}
                  {peer.blocked && <span className="status err-t"> {t('peers', 'state.blocked')}</span>}
                  {peer.dormant && <span className="status muted"> {t('peers', 'state.dormant')}</span>}
                  {peer.reason && <span className="muted"> {peer.reason}</span>}
                </td>
                <td data-label={t('peers', 'colActions')}>
                  <PeerForm className="peer-actions">
                    <input type="hidden" name="domain" value={peer.domain} />
                    <input name="reason" aria-label={t('peers', 'reason')} placeholder={t('peers', 'reason')} maxLength={10000} />
                    {peer.media === 'approved' ? (
                      <Button type="submit" name="intent" value="quarantine" variant="neutral" size="sm">
                        {t('peers', 'quarantine')}
                      </Button>
                    ) : (
                      <Button type="submit" name="intent" value="approve" variant="neutral" size="sm">
                        {t('peers', 'approve')}
                      </Button>
                    )}
                    <Button type="submit" name="intent" value="purge" variant="neutral" size="sm" disabled={peer.media === 'denied'}>
                      {t('peers', 'purge')}
                    </Button>
                    <Button type="submit" name="intent" value={peer.inboxPaused ? 'resume' : 'pause'} variant="neutral" size="sm">
                      {t('peers', peer.inboxPaused ? 'resume' : 'pause')}
                    </Button>
                    <Button type="submit" name="intent" value={peer.blocked ? 'unblock' : 'block'} variant="neutral" size="sm">
                      {t('peers', peer.blocked ? 'unblock' : 'block')}
                    </Button>
                  </PeerForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">
        {t('peers', 'trusted', { hosts: data.trusted.length > 0 ? data.trusted.join(', ') : t('peers', 'none') })}{' '}
        <a href={adminPaths.settings}>{t('peers', 'settingsLink')}</a>
      </p>
    </AuthPage>
  );
}
