import { localHandles } from '@peblish/core/identity/handles';
import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { lookupInviteFor, PRIVATE_NO_STORE } from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { Hidden } from '../auth/-ui/form.tsx';
import { authHead } from '../auth/-route.ts';
import { AuthPage, FormActions, useDate } from '../auth/-ui/page.tsx';
import { input } from '../../server/input.ts';

const loadInvite = createServerFn({ method: 'GET' })
  .validator(input(type({ code: 'string' })))
  .handler(async ({ data }) => {
    // The code is a bearer secret: keep the server function's reply (a client-side navigation)
    // out of caches too, and the page out of search engines.
    setResponseHeader('cache-control', PRIVATE_NO_STORE);
    setResponseHeader('x-robots-tag', 'noindex');
    const { host } = await localHandles();
    // null: this client tried too many codes that match no invite (identity/throttle.ts).
    return { host, code: data.code, invite: await lookupInviteFor(getRequest(), data.code) };
  });

export const Route = createFileRoute('/invite/$code')({
  loader: ({ params }) => loadInvite({ data: { code: params.code } }),
  head: authHead,
  staticData: { viewHeader: 'own' },
  component: InviteLanding,
});

function InviteLanding() {
  const { t } = useTranslate();
  const { host, code, invite } = Route.useLoaderData();
  const date = useDate();
  useRouteHydrated();
  if (!invite)
    return (
      <AuthPage title={t('invites', 'landing.limitedTitle')} state="limited">
        <div className="auth-form">
          <Text as="p">{t('invites', 'landing.limitedBody')}</Text>
        </div>
      </AuthPage>
    );
  const inviter = invite.inviter ? `@${invite.inviter.handle}` : t('invites', 'landing.someone');
  const titles = {
    valid: t('invites', 'landing.validTitle', { host }),
    expired: t('invites', 'landing.expiredTitle'),
    exhausted: t('invites', 'landing.exhaustedTitle'),
    revoked: t('invites', 'landing.revokedTitle'),
    unknown: t('invites', 'landing.unknownTitle'),
  };
  const elsewhere = (
    <FormActions
      aside={
        <>
          <Link href="/auth/sign-up">{t('invites', 'landing.otherCode')}</Link>
          <Link href="/auth/sign-in">{t('invites', 'landing.signIn')}</Link>
        </>
      }
    />
  );
  return (
    <AuthPage title={titles[invite.status]} state={invite.status}>
      <div className="auth-form">
        {invite.status === 'valid' && (
          <>
            <Text as="p">
              {invite.usesLeft === 1
                ? t('invites', 'landing.validByOne', { inviter, code })
                : t('invites', 'landing.validBy', { inviter, code, left: invite.usesLeft })}
            </Text>
            <Text as="p">{t('invites', 'landing.validAbout', { host })}</Text>
            <FormActions
              aside={
                <Text as="p" size="sm">
                  <Link href="/auth/sign-in">{t('invites', 'landing.haveAccount')}</Link>
                </Text>
              }
            >
              <form method="get" action="/auth/sign-up">
                <Hidden name="invite" value={code} />
                <Button type="submit" variant="primary">
                  {t('invites', 'landing.continue')}
                </Button>
              </form>
            </FormActions>
          </>
        )}
        {invite.status === 'expired' && (
          <>
            <Text as="p">{t('invites', 'landing.expiredBody', { date: invite.expiresAt ? date(invite.expiresAt) : '', inviter })}</Text>
            {elsewhere}
          </>
        )}
        {invite.status === 'exhausted' && (
          <>
            <Text as="p">{t('invites', 'landing.exhaustedBody', { inviter })}</Text>
            {elsewhere}
          </>
        )}
        {invite.status === 'revoked' && (
          <>
            <Text as="p">{t('invites', 'landing.revokedBody')}</Text>
            {elsewhere}
          </>
        )}
        {invite.status === 'unknown' && (
          <>
            <Text as="p">{t('invites', 'landing.unknownBody')}</Text>
            {elsewhere}
          </>
        )}
      </div>
    </AuthPage>
  );
}
