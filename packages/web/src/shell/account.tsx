import type { SessionView } from '@peblish/schema/session';
import { useTranslate } from '../i18n/use-translate.ts';
import { userPath } from './paths.ts';

/**
 * The account area of the top bar: sign-in and sign-up links when signed out; when signed in,
 * a menu with the profile, settings, security, invites (admins) and sign-out (a form posting
 * to /auth/sign-out, which answers with a redirect).
 */
export function Account({ session }: { session: SessionView | null }) {
  const { t } = useTranslate();
  if (!session) {
    return (
      <nav className="pb-account" aria-label={t('shell', 'account.menu')}>
        <a href="/auth/sign-in">{t('shell', 'account.signIn')}</a>
        <a className="pb-account__signup" href="/auth/sign-up">
          {t('shell', 'account.signUp')}
        </a>
      </nav>
    );
  }
  const name = session.displayName ?? session.name;
  return (
    <details className="pb-menu pb-account">
      <summary>
        <span className="pb-avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="pb-sr">{t('shell', 'account.menu')}: </span>
        <span className="pb-account__name">{name}</span>
      </summary>
      <div className="pb-menu__panel">
        <a href={userPath({ handle: session.name })}>{t('shell', 'account.profile')}</a>
        <a href="/settings/account">{t('shell', 'account.settings')}</a>
        <a href="/settings/security">{t('shell', 'account.security')}</a>
        {session.siteRole === 'admin' && <a href="/admin/registration">{t('shell', 'account.invites')}</a>}
        <form method="post" action="/auth/sign-out">
          <button type="submit">{t('shell', 'account.signOut')}</button>
        </form>
      </div>
    </details>
  );
}
