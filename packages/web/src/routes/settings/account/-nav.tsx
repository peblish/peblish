import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';

/** The settings column (mock: auth-pages.html, Security): Account, Security, and Invites for admins. */
export function SettingsLayout({ admin, children }: { admin: boolean; children: ReactNode }) {
  const { t } = useTranslate();
  return (
    <div className="auth-page settings">
      <nav className="settings-nav" aria-label={t('settings', 'nav.label')}>
        <Link to="/settings/account" activeProps={{ 'aria-current': 'page' }}>
          {t('settings', 'nav.account')}
        </Link>
        <Link to="/settings/security" activeProps={{ 'aria-current': 'page' }}>
          {t('settings', 'nav.security')}
        </Link>
        {admin && <Link to="/admin/registration">{t('settings', 'nav.invites')}</Link>}
      </nav>
      <main>{children}</main>
    </div>
  );
}
