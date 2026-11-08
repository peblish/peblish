import { findLocalPerson, localHandles } from '@peblish/core/identity/handles';
import { createInviteAs, listInvites, lookupInvite, revokeInviteAs } from '@peblish/core/registration/invites';
import { registrationOverview } from '@peblish/core/registration/settings';
import { InviteCreateBody, type InviteRow, type InviteStatus } from '@peblish/schema/invite';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, principalOf, readForm, respond, sameOrigin, sessionOf } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { asFormError } from '../../auth/-ui/errors.ts';
import { AuthForm, Field } from '../../auth/-ui/form.tsx';
import { authHead, SearchText, useDate } from '../../auth/-ui/page.tsx';

const Search = type({ 'error?': SearchText, 'created?': SearchText });
const Body = InviteCreateBody.and({ intent: "'create'" }).or({ intent: "'revoke'", invite: 'string.uuid' });

const loadRegistration = createServerFn({ method: 'GET' })
  .validator(type({ 'created?': 'string' }))
  .handler(async ({ data }) => {
    const session = await sessionOf(getRequest());
    if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: '/admin/registration' } });
    const { origin, handle } = await localHandles();
    const access = session.role !== 'admin' ? 'not-admin' : session.view.siteRole !== 'admin' ? 'needs-two-factor' : 'ok';
    if (access !== 'ok') return { access } as const;
    const [registration, invites] = await Promise.all([registrationOverview(), listInvites()]);
    const created = data.created ? { code: data.created, ...(await lookupInvite(data.created)) } : null;
    return { access, origin, me: handle(session.view.name).handle, registration, invites, created } as const;
  });

const days = { '7': 7, '30': 30, '90': 90, never: null } as const;

export const Route = createFileRoute('/admin/registration/')({
  validateSearch: Search,
  loaderDeps: ({ search }) => ({ created: search.created }),
  loader: ({ deps }) => loadRegistration({ data: deps.created ? { created: deps.created } : {} }),
  head: authHead,
  component: Registration,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const session = await sessionOf(request);
        if (!session) return respond(request, { redirect: '/auth/sign-in?redirect=%2Fadmin%2Fregistration' });
        const body = Body(await readForm(request));
        const back = { back: '/admin/registration' };
        if (body instanceof type.errors) return respond(request, { error: 'form.invalid', ...back });
        const principal = principalOf(session.view);
        if (body.intent === 'revoke') {
          const revoked = await revokeInviteAs(principal, body.invite);
          if (!revoked.ok) return respond(request, { error: asFormError(revoked.reason) ?? 'generic', ...back });
          return respond(request, { redirect: '/admin/registration' });
        }
        const maxUses = Number(body.maxUses);
        if (!Number.isInteger(maxUses) || maxUses < 1) return respond(request, { error: 'form.invalid', ...back });
        // The referrer defaults to the admin; the chain then starts at them.
        const referrer = await findLocalPerson(body.referrer.trim() || session.view.name);
        if (!referrer) return respond(request, { error: 'target.not_found', ...back });
        const expiryDays = days[body.expires];
        const created = await createInviteAs(principal, {
          referrerId: referrer.id,
          label: body.label.trim() || null,
          maxUses,
          expiresAt: expiryDays === null ? null : new Date(Date.now() + expiryDays * 86_400_000),
        });
        if (!created.ok) return respond(request, { error: asFormError(created.reason) ?? 'generic', ...back });
        // The code is shown once, on the page this redirect opens.
        return respond(request, { redirect: `/admin/registration?created=${encodeURIComponent(created.code)}` });
      },
    },
  },
});

const statusClass: Record<InviteStatus, string> = {
  valid: 'ok-t',
  expired: 'warn-t',
  exhausted: 'muted',
  revoked: 'err-t',
  unknown: 'muted',
};

function Registration() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  if (data.access !== 'ok')
    return (
      <main className="auth-page">
        <h1>{t('invites', 'admin.title')}</h1>
        {data.access === 'needs-two-factor' ? (
          <p role="alert">
            {t('invites', 'admin.needsTwoFactor')} <Link to="/settings/security">{t('invites', 'admin.securityLink')}</Link>
          </p>
        ) : (
          <p role="alert">{t('invites', 'admin.notAdmin')}</p>
        )}
      </main>
    );
  return (
    <main className="auth-page wide">
      <h1>{t('invites', 'admin.title')}</h1>
      <div className="regl">
        <span>
          <b>{t('invites', 'admin.registration')}</b> {t('invites', data.registration.enabled ? 'admin.inviteOnly' : 'admin.paused')}
        </span>
        <span>{t('invites', 'admin.cap', { count: data.registration.accounts, cap: data.registration.cap })}</span>
      </div>
      <AuthForm action="/admin/registration" label={t('invites', 'admin.createLabel')} error={asFormError(search.error)}>
        <div className="invite-create">
          <input type="hidden" name="intent" value="create" />
          <Field label={t('invites', 'admin.label')} name="label" placeholder={t('invites', 'admin.labelPlaceholder')} />
          <Field label={t('invites', 'admin.referrer')} name="referrer" defaultValue={`@${data.me}`} />
          <Field label={t('invites', 'admin.maxUses')} name="maxUses" type="number" min={1} defaultValue={1} required />
          <ExpirySelect />
          <Button type="submit" variant="primary">
            {t('invites', 'admin.create')}
          </Button>
        </div>
      </AuthForm>
      {data.created && <CreatedInvite created={data.created} origin={data.origin} />}
      <InvitesTable invites={data.invites} />
    </main>
  );
}

function ExpirySelect() {
  const { t } = useTranslate();
  return (
    <div className="fld">
      <label htmlFor="invite-expires">{t('invites', 'admin.expires')}</label>
      <select id="invite-expires" name="expires" defaultValue="30">
        <option value="7">{t('invites', 'admin.in7')}</option>
        <option value="30">{t('invites', 'admin.in30')}</option>
        <option value="90">{t('invites', 'admin.in90')}</option>
        <option value="never">{t('invites', 'admin.never')}</option>
      </select>
    </div>
  );
}

function CreatedInvite({ created, origin }: { created: { code: string; maxUses: number; expiresAt: string | null }; origin: string }) {
  const { t } = useTranslate();
  const date = useDate();
  const [copied, setCopied] = useState(false);
  const link = new URL(`/invite/${created.code}`, origin).href;
  return (
    <div className="invite-new" role="status">
      <b className="ok-t">{t('invites', 'admin.created')}</b>{' '}
      <span className="mono" data-testid="invite-code">
        {created.code}
      </span>{' '}
      · {created.maxUses === 1 ? t('invites', 'admin.usesOne') : t('invites', 'admin.usesMany', { count: created.maxUses })} ·{' '}
      {created.expiresAt ? t('invites', 'admin.expiresOn', { date: date(created.expiresAt) }) : t('invites', 'admin.noExpiry')} ·{' '}
      <a href={link}>{link}</a>{' '}
      <Button variant="ghost" size="sm" onActivate={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
        {copied ? t('invites', 'admin.copied') : t('invites', 'admin.copyLink')}
      </Button>
      <p className="hint">{t('invites', 'admin.createdHint')}</p>
    </div>
  );
}

function InvitesTable({ invites }: { invites: InviteRow[] }) {
  const { t } = useTranslate();
  const date = useDate();
  if (invites.length === 0) return <p className="muted">{t('invites', 'admin.empty')}</p>;
  return (
    <table className="invites">
      <thead>
        <tr>
          <th>{t('invites', 'admin.colInvite')}</th>
          <th>{t('invites', 'admin.colReferrer')}</th>
          <th>{t('invites', 'admin.colUses')}</th>
          <th>{t('invites', 'admin.colExpires')}</th>
          <th>{t('invites', 'admin.colStatus')}</th>
          <th>{t('invites', 'admin.colUsedBy')}</th>
          <th>
            <span className="sr">{t('invites', 'admin.colActions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {invites.map((invite) => (
          <tr key={invite.id} data-testid="invite-row">
            <td data-label={t('invites', 'admin.colInvite')}>
              {invite.label ?? <span className="muted">{t('invites', 'admin.noLabel')}</span>}
            </td>
            <td data-label={t('invites', 'admin.colReferrer')}>{invite.referrer ? `@${invite.referrer.handle}` : ''}</td>
            <td data-label={t('invites', 'admin.colUses')}>
              {invite.uses} / {invite.maxUses}
            </td>
            <td data-label={t('invites', 'admin.colExpires')}>
              {invite.expiresAt ? date(invite.expiresAt) : t('invites', 'admin.neverShort')}
            </td>
            <td data-label={t('invites', 'admin.colStatus')}>
              <span className={`status ${statusClass[invite.status]}`}>{t('invites', `admin.status.${invite.status}`)}</span>
            </td>
            <td data-label={t('invites', 'admin.colUsedBy')}>
              {invite.usedBy.length === 0 ? (
                <span className="muted">{t('invites', 'admin.nobody')}</span>
              ) : (
                <details>
                  <summary>
                    {invite.usedBy.length === 1
                      ? t('invites', 'admin.peopleOne')
                      : t('invites', 'admin.peopleMany', { count: invite.usedBy.length })}
                  </summary>
                  <ul className="used-by">
                    {invite.usedBy.map((person) => (
                      <li key={person.handle}>
                        <span>
                          @{person.handle}
                          {person.deleted ? (
                            <span className="muted"> {t('invites', 'admin.deleted')}</span>
                          ) : (
                            !person.emailVerified && <span className="warn-t"> {t('invites', 'admin.unverified')}</span>
                          )}
                        </span>
                        <span className="muted">{date(person.usedAt)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </td>
            <td data-label="">
              {invite.status !== 'revoked' && (
                <form method="post" action="/admin/registration">
                  <input type="hidden" name="intent" value="revoke" />
                  <input type="hidden" name="invite" value={invite.id} />
                  <Button type="submit" variant="neutral" size="sm">
                    {t('invites', 'admin.revoke')}
                  </Button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
