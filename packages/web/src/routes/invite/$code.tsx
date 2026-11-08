import { localHandles } from '@peblish/core/identity/handles';
import { lookupInvite } from '@peblish/core/registration/invites';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { PRIVATE_NO_STORE } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { authHead, useDate } from '../auth/-ui/page.tsx';

const loadInvite = createServerFn({ method: 'GET' })
  .validator(type({ code: 'string' }))
  .handler(async ({ data }) => {
    // The code is a bearer secret: keep the server function's reply (a client-side navigation)
    // out of caches too, and the page out of search engines.
    setResponseHeader('cache-control', PRIVATE_NO_STORE);
    setResponseHeader('x-robots-tag', 'noindex');
    const { host } = await localHandles();
    return { host, code: data.code, invite: await lookupInvite(data.code) };
  });

export const Route = createFileRoute('/invite/$code')({
  loader: ({ params }) => loadInvite({ data: { code: params.code } }),
  head: authHead,
  component: InviteLanding,
});

function InviteLanding() {
  const { t } = useTranslate();
  const { host, code, invite } = Route.useLoaderData();
  const date = useDate();
  useRouteHydrated();
  const inviter = invite.inviter ? `@${invite.inviter.handle}` : t('invites', 'landing.someone');
  const elsewhere = (
    <div className="btns">
      <Link to="/auth/sign-up">{t('invites', 'landing.otherCode')}</Link>
      <Link to="/auth/sign-in">{t('invites', 'landing.signIn')}</Link>
    </div>
  );
  return (
    <main className="auth-page" data-state={invite.status}>
      {invite.status === 'valid' && (
        <>
          <h1>{t('invites', 'landing.validTitle', { host })}</h1>
          <p>
            {invite.usesLeft === 1
              ? t('invites', 'landing.validByOne', { inviter, code })
              : t('invites', 'landing.validBy', { inviter, code, left: invite.usesLeft })}
          </p>
          <p>{t('invites', 'landing.validAbout', { host })}</p>
          <div className="btns">
            <form method="get" action="/auth/sign-up">
              <input type="hidden" name="invite" value={code} />
              <Button type="submit" variant="primary">
                {t('invites', 'landing.continue')}
              </Button>
            </form>
            <Link to="/auth/sign-in">{t('invites', 'landing.haveAccount')}</Link>
          </div>
        </>
      )}
      {invite.status === 'expired' && (
        <>
          <h1>{t('invites', 'landing.expiredTitle')}</h1>
          <p>{t('invites', 'landing.expiredBody', { date: invite.expiresAt ? date(invite.expiresAt) : '', inviter })}</p>
          {elsewhere}
        </>
      )}
      {invite.status === 'exhausted' && (
        <>
          <h1>{t('invites', 'landing.exhaustedTitle')}</h1>
          <p>{t('invites', 'landing.exhaustedBody', { inviter })}</p>
          {elsewhere}
        </>
      )}
      {invite.status === 'revoked' && (
        <>
          <h1>{t('invites', 'landing.revokedTitle')}</h1>
          <p>{t('invites', 'landing.revokedBody')}</p>
          {elsewhere}
        </>
      )}
      {invite.status === 'unknown' && (
        <>
          <h1>{t('invites', 'landing.unknownTitle')}</h1>
          <p>{t('invites', 'landing.unknownBody')}</p>
          {elsewhere}
        </>
      )}
    </main>
  );
}
