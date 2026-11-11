import { putFlash, takeFlash } from '@peblish/core/identity/flash';
import { findLocalPerson, localHandles } from '@peblish/core/identity/handles';
import { createInviteAs, listInvites, lookupInvite, revokeInviteAs } from '@peblish/core/registration/invites';
import { registrationOverview } from '@peblish/core/registration/settings';
import { InviteCreateBody, type InviteRow, type InviteStatus } from '@peblish/schema/invite';
import { Badge, type BadgeTone } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Disclosure } from '@peblish/ui/components/disclosure';
import { Input } from '@peblish/ui/components/input';
import { Link } from '@peblish/ui/components/link';
import { Meter } from '@peblish/ui/components/meter';
import { Notice } from '@peblish/ui/components/notice';
import { Select } from '@peblish/ui/components/select';
import { Table } from '@peblish/ui/components/table';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { adminPaths } from '../../../shell/paths.ts';
import { asFormError, errorKey } from '../../auth/-ui/errors.ts';
import { SearchText, useDate } from '../../auth/-ui/page.tsx';
import { Denial } from '../-denial.tsx';
import { accessOf } from '../settings/-access.ts';
import { AdminTitle } from '../settings/-ui.tsx';

const Search = type({ 'error?': SearchText });
// The Registration tab: the registration line, the create form (a plain POST: 303 back here, or
// with ?error=<code>), the new invite's code shown once, and the invites table, whose Revoke
// buttons submit one form outside the table that names the invite by the button's value.
const Body = InviteCreateBody.and({ intent: "'create'" }).or({ intent: "'revoke'", invite: 'string.uuid' });

/** The flash (identity/flash.ts) that carries a new invite's code from the POST to this page, once. */
const CREATED = 'created-invite';

const loadRegistration = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: '/admin/registration' } });
  const { origin, handle } = await localHandles();
  const access = accessOf(session);
  // Signed in but not an admin whose session passed two-factor: the denial copy, answered as a 403 (as the other admin tabs do).
  if (access !== 'ok') {
    setResponseStatus(403);
    return { access } as const;
  }
  const [registration, invites, code] = await Promise.all([registrationOverview(), listInvites(), takeFlash(session.sessionId, CREATED)]);
  // The code of the invite just made, on the first view after making it and never again.
  const created = code ? { code, ...(await lookupInvite(code)) } : null;
  return { access, origin, me: handle(session.view.name).handle, registration, invites, created } as const;
});

const days = { '7': 7, '30': 30, '90': 90, never: null } as const;

export const Route = createFileRoute('/admin/registration/')({
  validateSearch: Search,
  loader: () => loadRegistration(),
  component: Registration,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session, reply } = await formSession(request);
        if (!session) return reply({ redirect: '/auth/sign-in?redirect=%2Fadmin%2Fregistration' });
        const body = Body(await readForm(request));
        const back = { back: '/admin/registration' };
        if (body instanceof type.errors) return reply({ error: 'form.invalid', ...back });
        const principal = principalOf(session.view);
        if (body.intent === 'revoke') {
          const revoked = await revokeInviteAs(principal, body.invite);
          if (!revoked.ok) return reply({ error: asFormError(revoked.reason) ?? 'generic', ...back });
          return reply({ redirect: '/admin/registration' });
        }
        const maxUses = Number(body.maxUses);
        if (!Number.isInteger(maxUses) || maxUses < 1) return reply({ error: 'form.invalid', ...back });
        // The referrer defaults to the admin; the chain then starts at them.
        const referrer = await findLocalPerson(body.referrer.trim() || session.view.name);
        if (!referrer) return reply({ error: 'target.not_found', ...back });
        const expiryDays = days[body.expires];
        const created = await createInviteAs(principal, {
          referrerId: referrer.id,
          label: body.label.trim() || null,
          maxUses,
          expiresAt: expiryDays === null ? null : new Date(Date.now() + expiryDays * 86_400_000),
        });
        if (!created.ok) return reply({ error: asFormError(created.reason) ?? 'generic', ...back });
        // The code is shown once, on the page this redirect opens, and never rides in its URL.
        await putFlash(session.sessionId, CREATED, created.code);
        return reply({ redirect: '/admin/registration' });
      },
    },
  },
});

const statusTone: Record<InviteStatus, BadgeTone> = {
  valid: 'success',
  expired: 'warning',
  exhausted: 'neutral',
  revoked: 'danger',
  unknown: 'neutral',
};

const path = '/admin/registration';
const revokeForm = 'revoke-invite';

function Registration() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  if (data.access !== 'ok')
    return (
      <main className="pb-page adm-page">
        <AdminTitle>{t('invites', 'admin.title')}</AdminTitle>
        <Denial
          access={data.access}
          copy={{
            needsTwoFactor: t('invites', 'admin.needsTwoFactor'),
            securityLink: t('invites', 'admin.securityLink'),
            notAdmin: t('invites', 'admin.notAdmin'),
          }}
        />
      </main>
    );
  const { registration } = data;
  const error = asFormError(search.error);
  const cap = t('invites', 'admin.cap', { count: registration.accounts, cap: registration.cap });
  return (
    <main className="pb-page adm-page">
      <AdminTitle>{t('invites', 'admin.title')}</AdminTitle>
      <div className="adm-summary">
        <Text variant="label" size="md">
          {t('invites', 'admin.registration')}
        </Text>
        <Badge tone={registration.enabled ? 'success' : 'warning'}>
          {t('invites', registration.enabled ? 'admin.inviteOnly' : 'admin.paused')}
        </Badge>
        {registration.cap > 0 ? (
          <Meter label={cap} value={registration.accounts} maxValue={registration.cap} className="adm-meter" />
        ) : (
          <Text>{cap}</Text>
        )}
        {/* The switch and the cap are changed in the admin settings. */}
        <Link href={adminPaths.settings}>{t('invites', 'admin.settingsLink')}</Link>
      </div>
      {error && (
        <Notice role="alert" tone="danger">
          {t('auth', errorKey(error))}
        </Notice>
      )}
      <form method="post" action={path} aria-label={t('invites', 'admin.createLabel')} className="adm-create">
        <Input.Input type="hidden" name="intent" value="create" />
        <TextField label={t('invites', 'admin.label')} name="label" placeholder={t('invites', 'admin.labelPlaceholder')} />
        <TextField label={t('invites', 'admin.referrer')} name="referrer" defaultValue={`@${data.me}`} />
        <Input.Root defaultValue="1" required>
          <Input.Label>{t('invites', 'admin.maxUses')}</Input.Label>
          <Input.Input name="maxUses" type="number" min={1} inputMode="numeric" />
        </Input.Root>
        <Select
          label={t('invites', 'admin.expires')}
          name="expires"
          defaultValue="30"
          items={[
            { id: '7', label: t('invites', 'admin.in7') },
            { id: '30', label: t('invites', 'admin.in30') },
            { id: '90', label: t('invites', 'admin.in90') },
            { id: 'never', label: t('invites', 'admin.never') },
          ]}
        />
        <Button type="submit" variant="primary">
          {t('invites', 'admin.create')}
        </Button>
      </form>
      {data.created && <CreatedInvite created={data.created} origin={data.origin} />}
      <InvitesTable invites={data.invites} />
    </main>
  );
}

/** The invite just made: its code and link, shown on this one view only, with a copy button. */
function CreatedInvite({ created, origin }: { created: { code: string; maxUses: number; expiresAt: string | null }; origin: string }) {
  const { t } = useTranslate();
  const date = useDate();
  const [copied, setCopied] = useState(false);
  const link = new URL(`/invite/${created.code}`, origin).href;
  return (
    <Notice
      role="status"
      tone="success"
      title={t('invites', 'admin.created')}
      action={
        <Button variant="neutral" size="sm" onActivate={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
          {copied ? t('invites', 'admin.copied') : t('invites', 'admin.copyLink')}
        </Button>
      }
    >
      <p>
        <Text variant="mono" data-testid="invite-code">
          {created.code}
        </Text>{' '}
        · {created.maxUses === 1 ? t('invites', 'admin.usesOne') : t('invites', 'admin.usesMany', { count: created.maxUses })} ·{' '}
        {created.expiresAt ? t('invites', 'admin.expiresOn', { date: date(created.expiresAt) }) : t('invites', 'admin.noExpiry')}
      </p>
      <p className="adm-break">
        <Link href={link}>{link}</Link>
      </p>
      <p>{t('invites', 'admin.createdHint')}</p>
    </Notice>
  );
}

function InvitesTable({ invites }: { invites: InviteRow[] }) {
  const { t } = useTranslate();
  const date = useDate();
  if (invites.length === 0)
    return (
      <Text as="p" color="muted">
        {t('invites', 'admin.empty')}
      </Text>
    );
  const actions = t('invites', 'admin.colActions');
  return (
    <Card.Root variant="outlined" padding="sm" className="adm-table">
      {/* One form for every Revoke button: each submits it with its invite's id. */}
      <form id={revokeForm} method="post" action={path} hidden>
        <Input.Input type="hidden" name="intent" value="revoke" />
      </form>
      <Table
        aria-label={t('invites', 'admin.title')}
        columns={[
          { id: 'invite', label: t('invites', 'admin.colInvite'), isRowHeader: true },
          { id: 'referrer', label: t('invites', 'admin.colReferrer') },
          { id: 'uses', label: t('invites', 'admin.colUses') },
          { id: 'expires', label: t('invites', 'admin.colExpires') },
          { id: 'status', label: t('invites', 'admin.colStatus') },
          { id: 'usedBy', label: t('invites', 'admin.colUsedBy') },
          { id: 'actions', label: <span className="pb-sr">{actions}</span>, textValue: actions },
        ]}
        rows={invites.map((invite) => ({
          id: invite.id,
          values: {
            invite: invite.label ?? <Text color="muted">{t('invites', 'admin.noLabel')}</Text>,
            referrer: invite.referrer ? `@${invite.referrer.handle}` : '',
            uses: `${invite.uses} / ${invite.maxUses}`,
            expires: invite.expiresAt ? date(invite.expiresAt) : t('invites', 'admin.neverShort'),
            status: <Badge tone={statusTone[invite.status]}>{t('invites', `admin.status.${invite.status}`)}</Badge>,
            usedBy:
              invite.usedBy.length === 0 ? (
                <Text color="muted">{t('invites', 'admin.nobody')}</Text>
              ) : (
                <Disclosure
                  title={
                    invite.usedBy.length === 1
                      ? t('invites', 'admin.peopleOne')
                      : t('invites', 'admin.peopleMany', { count: invite.usedBy.length })
                  }
                >
                  <ul className="adm-used-by">
                    {invite.usedBy.map((person) => (
                      <li key={person.handle}>
                        <span>
                          @{person.handle}{' '}
                          {person.deleted ? (
                            <Badge tone="neutral">{t('invites', 'admin.deleted')}</Badge>
                          ) : (
                            !person.emailVerified && <Badge tone="warning">{t('invites', 'admin.unverified')}</Badge>
                          )}
                        </span>
                        <Text size="sm" color="muted">
                          {date(person.usedAt)}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              ),
            actions:
              invite.status === 'revoked' ? null : (
                <Button type="submit" form={revokeForm} name="invite" value={invite.id} variant="neutral" size="sm">
                  {t('invites', 'admin.revoke')}
                </Button>
              ),
          },
        }))}
      />
    </Card.Root>
  );
}
