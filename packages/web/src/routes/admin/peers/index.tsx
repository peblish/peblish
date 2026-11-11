import type { PeerRow } from '@peblish/core/peers/read';
import { updatePeerAs } from '@peblish/core/peers/service';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Table } from '@peblish/ui/components/table';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, principalOf, privateResponses, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { adminPaths } from '../../../shell/paths.ts';
import { answer } from '../../post/-form.ts';
import { useDate } from '../../auth/-ui/page.tsx';
import { errorKey } from '../../modlog/-ui/panels.tsx';
import { Denial } from '../-denial.tsx';
import { changes, hostFrom, Body } from './-act.ts';
import { loadPeers } from './-load.ts';
import peersCss from './-ui/peers.css?url';

// /admin/peers: the Peers tab (R2 pick admin-tabs). Every instance we know of, with what this
// server does about it: its media (quarantined until approved, approved, purged), its inbox
// (paused: the peer retries), blocked (everything stops). A new peer starts with its media
// quarantined: its text shows, its images do not. Trusted-for-modlog is the settings tab's.
//
// The table only reads; a peer's controls (a reason box and one button per change, as before)
// open below it for the peer chosen with ?peer=<host>. A text field cannot sit in a Mux Table
// cell: the grid takes the arrow keys and typed letters for its own navigation.

const Search = (raw: Record<string, unknown>): { error?: string; peer?: string } => ({
  ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  ...(typeof raw.peer === 'string' ? { peer: raw.peer } : {}),
});

export const Route = createFileRoute('/admin/peers/')({
  validateSearch: Search,
  loader: () => loadPeers(),
  head: () => ({ links: [{ rel: 'stylesheet', href: peersCss }] }),
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
        <Notice tone="danger" role="alert" className="peers-error">
          {t('modlog', errorKey(error))}
        </Notice>
      )}
    </form>
  );
}

/** The peer's state as badges: its media always, then paused, blocked and dormant when they hold, then the reason. */
function PeerState({ peer }: { peer: PeerRow }) {
  const { t } = useTranslate();
  return (
    <span className="peers-state">
      <Badge tone={peer.media === 'approved' ? 'success' : 'warning'} data-testid="peer-media">
        {t('peers', `media.${peer.media}`)}
      </Badge>
      {peer.inboxPaused && <Badge tone="warning">{t('peers', 'state.paused')}</Badge>}
      {peer.blocked && <Badge tone="danger">{t('peers', 'state.blocked')}</Badge>}
      {peer.dormant && <Badge tone="neutral">{t('peers', 'state.dormant')}</Badge>}
      {peer.reason && (
        <Text size="sm" color="muted">
          {peer.reason}
        </Text>
      )}
    </span>
  );
}

/** The chosen peer's controls: a reason that goes with whichever button is pressed, and one button per change. */
function PeerControls({ peer }: { peer: PeerRow }) {
  const { t } = useTranslate();
  return (
    <Card.Root variant="outlined" padding="sm" className="peers-controls" id="peer-controls" data-testid="peer-controls">
      <Card.Header>
        <Text as="h2" variant="title" size="sm">
          {t('peers', 'controlsFor', { host: peer.domain })}
        </Text>
      </Card.Header>
      <Card.Body>
        <PeerState peer={peer} />
        <PeerForm className="peers-form">
          <input type="hidden" name="domain" value={peer.domain} />
          <TextField name="reason" label={t('peers', 'reason')} maxLength={10000} />
          <div className="peers-buttons">
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
          </div>
        </PeerForm>
      </Card.Body>
    </Card.Root>
  );
}

function Peers() {
  const { t, locale } = useTranslate();
  const data = Route.useLoaderData();
  const { error, peer: chosen } = Route.useSearch();
  const date = useDate();
  const number = new Intl.NumberFormat(locale);
  useRouteHydrated();
  if (data.access !== 'ok')
    return (
      <main className="pb-page peers-page">
        <Text as="h1" variant="heading" size="sm">
          {t('peers', 'title')}
        </Text>
        <Denial
          access={data.access}
          copy={{
            needsTwoFactor: t('peers', 'needsTwoFactor'),
            securityLink: t('peers', 'securityLink'),
            notAdmin: t('peers', 'notAdmin'),
          }}
        />
      </main>
    );
  const selected = chosen ? data.peers.find((peer) => peer.domain === chosen) : undefined;
  return (
    <main className="pb-page peers-page">
      <Text as="h1" variant="heading" size="sm">
        {t('peers', 'title')}
      </Text>
      <Text as="p" color="muted">
        {t('peers', 'intro')}
      </Text>
      <PeerForm initialError={error} className="peers-add">
        <TextField name="domain" label={t('peers', 'blockHost')} placeholder={t('peers', 'hostPlaceholder')} required />
        <TextField name="reason" label={t('peers', 'reason')} maxLength={10000} />
        <Button type="submit" name="intent" value="block" variant="primary">
          {t('peers', 'block')}
        </Button>
      </PeerForm>
      {data.peers.length === 0 ? (
        <EmptyState title={t('peers', 'empty')} />
      ) : (
        <Card.Root variant="outlined" padding="sm" className="peers-table">
          <Table
            aria-label={t('peers', 'title')}
            columns={[
              { id: 'host', label: t('peers', 'colHost'), isRowHeader: true },
              { id: 'software', label: t('peers', 'colSoftware') },
              { id: 'people', label: t('peers', 'colPeople') },
              { id: 'heard', label: t('peers', 'colHeard') },
              { id: 'state', label: t('peers', 'colState') },
              { id: 'actions', label: t('peers', 'colActions') },
            ]}
            rows={data.peers.map((peer) => ({
              id: peer.instanceId,
              values: {
                host: peer.domain,
                software: peer.software ?? <Text color="muted">{t('peers', 'unknown')}</Text>,
                people: number.format(peer.people),
                heard: peer.lastHeardAt ? date(peer.lastHeardAt) : <Text color="muted">{t('peers', 'never')}</Text>,
                state: <PeerState peer={peer} />,
                actions: (
                  <Link
                    href={`${adminPaths.peers}?${new URLSearchParams({ peer: peer.domain })}#peer-controls`}
                    aria-label={t('peers', 'controlsFor', { host: peer.domain })}
                  >
                    {t('peers', 'controls')}
                  </Link>
                ),
              },
            }))}
          />
        </Card.Root>
      )}
      {selected && <PeerControls key={selected.domain} peer={selected} />}
      <Text as="p" color="muted">
        {t('peers', 'trusted', { hosts: data.trusted.length > 0 ? data.trusted.join(', ') : t('peers', 'none') })}{' '}
        <Link href={adminPaths.settings}>{t('peers', 'settingsLink')}</Link>
      </Text>
    </main>
  );
}
