import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Text } from '@peblish/ui/components/text';
import { useLocation } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { PageTitle } from '../../auth/-ui/page.tsx';

/**
 * A settings page in the Commons frame's centre column: the page's name, then Account, Security, Blocks,
 * and Invites for admins, as tabs that are real links (so they work before hydration), then its sections.
 */
export function SettingsLayout({ admin, title, children }: { admin: boolean; title: string; children: ReactNode }) {
  const { t } = useTranslate();
  const { pathname } = useLocation();
  const item = (to: string, label: string) => ({ to, label, active: pathname.replace(/\/+$/, '') === to });
  return (
    <main className="pb-page settings settings__page">
      <PageTitle>{title}</PageTitle>
      <LinkTabs
        aria-label={t('settings', 'nav.label')}
        className="settings__nav"
        items={[
          item('/settings/account', t('settings', 'nav.account')),
          item('/settings/security', t('settings', 'nav.security')),
          item('/settings/blocks', t('settings', 'nav.blocks')),
          ...(admin ? [item('/admin/registration', t('settings', 'nav.invites'))] : []),
        ]}
      />
      <div className="settings__main">{children}</div>
    </main>
  );
}

/** One settings section, flat on the page and named by its heading; a rule sets it off from the one before. */
export function SettingsSection({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className="settings__section">
      <Text as="h2" variant="title" size="sm" id={`${id}-title`}>
        {title}
      </Text>
      <div className="settings__body">{children}</div>
    </section>
  );
}
