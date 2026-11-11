import type { SessionView } from '@peblish/schema/session';
import { Avatar } from '@peblish/ui/components/avatar';
import { Link } from '@peblish/ui/components/link';
import { Menu } from '@peblish/ui/components/menu';
import { useRouter } from '@tanstack/react-router';
import { useRef } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { openInRouter } from './client-links.ts';
import { adminPaths, userPath } from './paths.ts';

const signOutAction = '/auth/sign-out';

/**
 * The account area of the top bar: sign-in and sign-up links when signed out; when signed in,
 * a Mux menu with the profile, settings, security, invites and the admin pages (admins) and
 * sign-out. Menu items are not links in Mux UI, so each one navigates through the router, and
 * sign-out submits a real form posting to /auth/sign-out (which answers with a redirect). The
 * menu needs scripts; without them the settings page still has its own sign-out form.
 */
export function Account({ session }: { session: SessionView | null }) {
  const { t } = useTranslate();
  const router = useRouter();
  const signOut = useRef<HTMLFormElement>(null);
  if (!session) {
    return (
      <nav className="pb-account" aria-label={t('shell', 'account.menu')}>
        <Link href="/auth/sign-in">{t('shell', 'account.signIn')}</Link>
        <Link className="pb-cta" href="/auth/sign-up">
          {t('shell', 'account.signUp')}
        </Link>
      </nav>
    );
  }
  const name = session.displayName ?? session.name;
  const pages = [
    { id: 'profile', href: userPath({ handle: session.name }), label: t('shell', 'account.profile') },
    { id: 'settings', href: '/settings/account', label: t('shell', 'account.settings') },
    { id: 'security', href: '/settings/security', label: t('shell', 'account.security') },
    ...(session.siteRole === 'admin'
      ? [
          { id: 'invites', href: adminPaths.registration, label: t('shell', 'account.invites') },
          { id: 'admin', href: adminPaths.settings, label: t('shell', 'account.admin') },
        ]
      : []),
  ];
  return (
    <div className="pb-account">
      <Menu.Root>
        <Menu.Trigger className="pb-account__trigger">
          <Avatar.Root size="sm" aria-hidden="true">
            <Avatar.Fallback>{name.slice(0, 1).toUpperCase()}</Avatar.Fallback>
          </Avatar.Root>
          <span className="pb-sr">{t('shell', 'account.menu')}: </span>
          <span className="pb-account__name">{name}</span>
        </Menu.Trigger>
        <Menu.Popup placement="bottom-end">
          <Menu.List aria-label={t('shell', 'account.menu')}>
            {pages.map(({ id, href, label }) => (
              <Menu.Item key={id} id={id} onAction={() => openInRouter(router, href)}>
                {label}
              </Menu.Item>
            ))}
            <Menu.Separator />
            <Menu.Item id="sign-out" onAction={() => signOut.current?.requestSubmit()}>
              {t('shell', 'account.signOut')}
            </Menu.Item>
          </Menu.List>
        </Menu.Popup>
      </Menu.Root>
      <form ref={signOut} method="post" action={signOutAction} hidden />
    </div>
  );
}
