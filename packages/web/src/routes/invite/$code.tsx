import { localHandles } from '@peblish/core/identity/handles';
import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Separator } from '@peblish/ui/components/separator';
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
import { AuthCard, useDate } from '../auth/-ui/page.tsx';

const loadInvite = createServerFn({ method: 'GET' })
  .validator(type({ code: 'string' }))
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
  component: InviteLanding,
});

function InviteLanding() {
  const { t } = useTranslate();
  const { host, code, invite } = Route.useLoaderData();
  const date = useDate();
  useRouteHydrated();
  const title = (text: string) => (
    <Text as="h1" variant="heading" size="sm">
      {text}
    </Text>
  );
  if (!invite)
    return (
      <AuthCard state="limited">
        <div className="auth-form">
          {title(t('invites', 'landing.limitedTitle'))}
          <Text as="p">{t('invites', 'landing.limitedBody')}</Text>
        </div>
      </AuthCard>
    );
  const inviter = invite.inviter ? `@${invite.inviter.handle}` : t('invites', 'landing.someone');
  const elsewhere = (
    <>
      <Separator />
      <div className="auth-links">
        <Link href="/auth/sign-up">{t('invites', 'landing.otherCode')}</Link>
        <Link href="/auth/sign-in">{t('invites', 'landing.signIn')}</Link>
      </div>
    </>
  );
  return (
    <AuthCard state={invite.status}>
      <div className="auth-form">
        {invite.status === 'valid' && (
          <>
            {title(t('invites', 'landing.validTitle', { host }))}
            <Text as="p">
              {invite.usesLeft === 1
                ? t('invites', 'landing.validByOne', { inviter, code })
                : t('invites', 'landing.validBy', { inviter, code, left: invite.usesLeft })}
            </Text>
            <Text as="p">{t('invites', 'landing.validAbout', { host })}</Text>
            <form method="get" action="/auth/sign-up" className="auth-form">
              <Hidden name="invite" value={code} />
              <Button type="submit" variant="primary" className="auth-submit">
                {t('invites', 'landing.continue')}
              </Button>
            </form>
            <Separator />
            <Text as="p" size="sm">
              <Link href="/auth/sign-in">{t('invites', 'landing.haveAccount')}</Link>
            </Text>
          </>
        )}
        {invite.status === 'expired' && (
          <>
            {title(t('invites', 'landing.expiredTitle'))}
            <Text as="p">{t('invites', 'landing.expiredBody', { date: invite.expiresAt ? date(invite.expiresAt) : '', inviter })}</Text>
            {elsewhere}
          </>
        )}
        {invite.status === 'exhausted' && (
          <>
            {title(t('invites', 'landing.exhaustedTitle'))}
            <Text as="p">{t('invites', 'landing.exhaustedBody', { inviter })}</Text>
            {elsewhere}
          </>
        )}
        {invite.status === 'revoked' && (
          <>
            {title(t('invites', 'landing.revokedTitle'))}
            <Text as="p">{t('invites', 'landing.revokedBody')}</Text>
            {elsewhere}
          </>
        )}
        {invite.status === 'unknown' && (
          <>
            {title(t('invites', 'landing.unknownTitle'))}
            <Text as="p">{t('invites', 'landing.unknownBody')}</Text>
            {elsewhere}
          </>
        )}
      </div>
    </AuthCard>
  );
}
