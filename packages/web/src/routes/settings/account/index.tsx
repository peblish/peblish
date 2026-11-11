import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { deleteAccountAs } from '@peblish/core/identity/delete';
import { localHandles } from '@peblish/core/identity/handles';
import { attempt } from '@peblish/core/identity/throttle';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { useTranslate } from '../../../i18n/use-translate.ts';
import {
  clientIp,
  forbidden,
  formSession,
  forwardedHeaders,
  pageSession,
  principalOf,
  readForm,
  sameOrigin,
  signedOutCookies,
} from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { asFormError } from '../../auth/-ui/errors.ts';
import { AuthForm, Field } from '../../auth/-ui/form.tsx';
import { SearchText, useDate } from '../../auth/-ui/page.tsx';
import { Badge, FactList } from '../-ui/interim.tsx';
import { SettingsLayout, SettingsSection, settingsHead } from './-nav.tsx';

const Search = type({ 'error?': SearchText });
const Body = type({ intent: "'delete'", confirm: 'string', password: 'string' });

const loadAccount = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: '/settings/account' } });
  const { handle } = await localHandles();
  return { ...session.view, handle: handle(session.view.name).handle, email: session.email, admin: session.role === 'admin' };
});

export const Route = createFileRoute('/settings/account/')({
  validateSearch: Search,
  loader: () => loadAccount(),
  head: settingsHead,
  component: Account,
  server: {
    handlers: {
      // Deleting the account: the username typed again and the password, then account.delete.
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session, reply } = await formSession(request);
        if (!session) return reply({ redirect: '/auth/sign-in?redirect=%2Fsettings%2Faccount' });
        const body = Body(await readForm(request));
        const back = { back: '/settings/account' };
        if (body instanceof type.errors) return reply({ error: 'form.invalid', ...back });
        if (body.confirm.trim() !== session.view.name) return reply({ error: 'confirm.mismatch', ...back });
        // Wrong passwords count against the account and the address; a right one is refunded.
        const counted = await attempt('password', { ip: clientIp(request), id: session.view.userId });
        if (!counted.allowed) return reply({ error: 'rate.limited', ...back });
        try {
          await (await auth()).api.verifyPassword({ body: { password: body.password }, headers: forwardedHeaders(request) });
          await counted.refund();
        } catch (error) {
          if (authErrorCode(error) === undefined) throw error;
          return reply({ error: 'password.wrong', ...back });
        }
        const deleted = await deleteAccountAs(principalOf(session.view), session.view.actorId, 'owner request');
        // A second submit that lost the race to the first finds the account already gone: done too.
        if (!deleted.ok && deleted.reason !== 'auth.actor_deleted')
          return reply({ error: asFormError(deleted.reason) ?? 'generic', ...back });
        return reply({ redirect: '/', cookies: await signedOutCookies() });
      },
    },
  },
});

function Account() {
  const { t } = useTranslate();
  const account = Route.useLoaderData();
  const search = Route.useSearch();
  const date = useDate();
  useRouteHydrated();
  return (
    <SettingsLayout admin={account.admin} title={t('settings', 'account.title')}>
      <Card.Root className="settings__section">
        <Card.Body className="settings__body">
          <FactList
            items={[
              { label: t('settings', 'account.username'), value: <Text variant="mono">@{account.handle}</Text> },
              {
                label: t('settings', 'account.email'),
                value: (
                  <span className="settings__row-name">
                    {account.email}
                    {account.emailVerified ? (
                      <Badge tone="success">{t('settings', 'account.verified')}</Badge>
                    ) : (
                      <>
                        <Badge tone="warning">{t('settings', 'account.unverified')}</Badge>
                        <Link href="/auth/verify">{t('settings', 'account.verify')}</Link>
                      </>
                    )}
                  </span>
                ),
              },
              {
                label: t('settings', 'account.age'),
                value: account.ageDeclaredAt
                  ? t('settings', 'account.declared', { date: date(account.ageDeclaredAt) })
                  : t('settings', 'account.notDeclared'),
              },
            ]}
          />
          <form method="post" action="/auth/sign-out">
            <Button type="submit" variant="neutral">
              {t('settings', 'account.signOut')}
            </Button>
          </form>
        </Card.Body>
      </Card.Root>
      <SettingsSection id="delete" title={t('settings', 'account.deleteTitle')}>
        <Text as="p" color="muted">
          {t('settings', 'account.deleteBody')}
        </Text>
        <AuthForm action="/settings/account" label={t('settings', 'account.deleteTitle')} error={asFormError(search.error)}>
          <Field label={t('settings', 'account.confirm')} name="confirm" required autoComplete="off" placeholder={account.name} />
          <Field label={t('settings', 'account.password')} name="password" type="password" required autoComplete="current-password" />
          {/* The intent rides on the submit button, which also submits on Enter (the form's default button). */}
          <Button type="submit" variant="danger" name="intent" value="delete">
            {t('settings', 'account.delete')}
          </Button>
        </AuthForm>
      </SettingsSection>
    </SettingsLayout>
  );
}
