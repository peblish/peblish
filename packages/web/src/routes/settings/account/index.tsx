import { auth, authErrorCode } from '@peblish/core/identity/auth';
import { deleteAccountAs } from '@peblish/core/identity/delete';
import { localHandles } from '@peblish/core/identity/handles';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useTranslate } from '../../../i18n/use-translate.ts';
import {
  forbidden,
  forwardedHeaders,
  principalOf,
  readForm,
  respond,
  sameOrigin,
  sessionOf,
  signedOutCookies,
} from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { asFormError } from '../../auth/-ui/errors.ts';
import { AuthForm, Field } from '../../auth/-ui/form.tsx';
import { authHead, SearchText, useDate } from '../../auth/-ui/page.tsx';
import { SettingsLayout } from './-nav.tsx';

const Search = type({ 'error?': SearchText });
const Body = type({ intent: "'delete'", confirm: 'string', password: 'string' });

const loadAccount = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await sessionOf(getRequest());
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: '/settings/account' } });
  const { handle } = await localHandles();
  return { ...session.view, handle: handle(session.view.name).handle, email: session.email, admin: session.role === 'admin' };
});

export const Route = createFileRoute('/settings/account/')({
  validateSearch: Search,
  loader: () => loadAccount(),
  head: authHead,
  component: Account,
  server: {
    handlers: {
      // Deleting the account: the username typed again and the password, then account.delete.
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const session = await sessionOf(request);
        if (!session) return respond(request, { redirect: '/auth/sign-in?redirect=%2Fsettings%2Faccount' });
        const body = Body(await readForm(request));
        const back = { back: '/settings/account' };
        if (body instanceof type.errors) return respond(request, { error: 'form.invalid', ...back });
        if (body.confirm.trim() !== session.view.name) return respond(request, { error: 'confirm.mismatch', ...back });
        try {
          await (await auth()).api.verifyPassword({ body: { password: body.password }, headers: forwardedHeaders(request) });
        } catch (error) {
          if (authErrorCode(error) === undefined) throw error;
          return respond(request, { error: 'password.wrong', ...back });
        }
        const deleted = await deleteAccountAs(principalOf(session.view), session.view.actorId, 'owner request');
        if (!deleted.ok) return respond(request, { error: asFormError(deleted.reason) ?? 'generic', ...back });
        return respond(request, { redirect: '/', cookies: await signedOutCookies() });
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
    <SettingsLayout admin={account.admin}>
      <h1>{t('settings', 'account.title')}</h1>
      <section className="sec">
        <p>
          <b>{t('settings', 'account.username')}</b> <span className="mono">@{account.handle}</span>
        </p>
        <p>
          <b>{t('settings', 'account.email')}</b> {account.email}{' '}
          {account.emailVerified ? (
            <span className="ok-t">{t('settings', 'account.verified')}</span>
          ) : (
            <span className="warn-t">
              {t('settings', 'account.unverified')} <Link to="/auth/verify">{t('settings', 'account.verify')}</Link>
            </span>
          )}
        </p>
        <p>
          <b>{t('settings', 'account.age')}</b>{' '}
          {account.ageDeclaredAt
            ? t('settings', 'account.declared', { date: date(account.ageDeclaredAt) })
            : t('settings', 'account.notDeclared')}
        </p>
        <form method="post" action="/auth/sign-out">
          <Button type="submit" variant="neutral">
            {t('settings', 'account.signOut')}
          </Button>
        </form>
      </section>
      <section className="sec">
        <h2>{t('settings', 'account.deleteTitle')}</h2>
        <p className="hint">{t('settings', 'account.deleteBody')}</p>
        <AuthForm action="/settings/account" label={t('settings', 'account.deleteTitle')} error={asFormError(search.error)}>
          <input type="hidden" name="intent" value="delete" />
          <Field label={t('settings', 'account.confirm')} name="confirm" required autoComplete="off" placeholder={account.name} />
          <Field label={t('settings', 'account.password')} name="password" type="password" required autoComplete="current-password" />
          <Button type="submit" variant="danger">
            {t('settings', 'account.delete')}
          </Button>
        </AuthForm>
      </section>
    </SettingsLayout>
  );
}
