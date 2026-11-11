import { Card } from '@peblish/ui/components/card';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { Text } from '@peblish/ui/components/text';
import { useLocation } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';

/**
 * The settings column: Account, Security, Blocks, and Invites for admins, as Mux Sidebar
 * navigation items (real links, so the column works before hydration), beside the page.
 */
export function SettingsLayout({ admin, title, children }: { admin: boolean; title: ReactNode; children: ReactNode }) {
  const { t } = useTranslate();
  const { pathname } = useLocation();
  const item = (href: string, label: string) => (
    <Sidebar.NavItem href={href} current={pathname.replace(/\/+$/, '') === href}>
      {label}
    </Sidebar.NavItem>
  );
  return (
    <div className="settings">
      <nav className="settings__nav" aria-label={t('settings', 'nav.label')}>
        <Sidebar.NavList>
          {item('/settings/account', t('settings', 'nav.account'))}
          {item('/settings/security', t('settings', 'nav.security'))}
          {item('/settings/blocks', t('settings', 'nav.blocks'))}
          {admin && item('/admin/registration', t('settings', 'nav.invites'))}
        </Sidebar.NavList>
      </nav>
      <main className="settings__main">
        <Text as="h1" variant="heading" size="lg">
          {title}
        </Text>
        {children}
      </main>
    </div>
  );
}

/** One settings section: an outlined Mux Card named by its heading. */
export function SettingsSection({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <Card.Root role="region" aria-labelledby={`${id}-title`} id={id} className="settings__section">
      <Card.Header>
        <Text as="h2" variant="title" size="md" id={`${id}-title`}>
          {title}
        </Text>
      </Card.Header>
      <Card.Body className="settings__body">{children}</Card.Body>
    </Card.Root>
  );
}
