import type { SessionView } from '@peblish/schema/session';
import { Avatar } from '@peblish/ui/components/avatar';
import { Button } from '@peblish/ui/components/button';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { BidiText } from '@peblish/ui/components/handle';
import { LogInIcon, UserPlusIcon } from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Menu } from '@peblish/ui/components/menu';
import { Text } from '@peblish/ui/components/text';
import { useRouter } from '@tanstack/react-router';
import { useTranslate } from '../i18n/use-translate.ts';
import { openInRouter } from './client-links.ts';
import { adminPaths, userPath } from './paths.ts';

const signOutAction = '/auth/sign-out';
/** The account list at the foot of every page (AccountLinks), which the no-script Account link points at. */
const accountLinksId = 'pb-account-links';
/** The one sign-out form: in AccountLinks, submitted by its own button or by the menu's Sign out. */
const signOutFormId = 'pb-sign-out';

type Translate = ReturnType<typeof useTranslate>['t'];

/** The account's pages, in the menu's order: Invites and Admin for admins only. */
function accountPages(session: SessionView, t: Translate) {
  return [
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
}

/** The avatar and the name, as the menu's button and the no-script link both show them. */
function AccountName({ name, label }: { name: string; label: string }) {
  return (
    <>
      <Avatar.Root size="sm" aria-hidden="true">
        <Avatar.Fallback>{name.slice(0, 1).toUpperCase()}</Avatar.Fallback>
      </Avatar.Root>
      <Text className="pb-sr">{label}: </Text>
      <Text variant="label" className="pb-account__name">
        <BidiText text={name} />
      </Text>
    </>
  );
}

/**
 * The account area of the top bar: sign-in and sign-up links when signed out; when signed in,
 * a Mux menu with the profile, settings, security, invites and the admin pages (admins) and
 * sign-out. Menu items are not links in Mux UI, so each one navigates through the router, and
 * sign-out submits the real form in AccountLinks (posting to /auth/sign-out, which answers with
 * a redirect). The menu needs scripts: with none (`scripting: none`, shell.css) its button gives
 * way to a plain link, with the same look and name, to the account list at the foot of the page.
 * A browser that does not know the media feature keeps the menu.
 */
export function Account({ session }: { session: SessionView | null }) {
  const { t } = useTranslate();
  const router = useRouter();
  if (!session) {
    return (
      <nav className="pb-account" aria-label={t('shell', 'account.menu')}>
        {/* On the narrowest phone bars the labels give way to the icons (shell.css); the names stay. */}
        <Link className="pb-sign-in pb-link-quiet" href="/auth/sign-in">
          <LogInIcon />
          <Text className="pb-action__label">{t('shell', 'account.signIn')}</Text>
        </Link>
        <ButtonLink className="pb-cta" href="/auth/sign-up" size="sm">
          <UserPlusIcon />
          <Text className="pb-action__label">{t('shell', 'account.signUp')}</Text>
        </ButtonLink>
      </nav>
    );
  }
  const name = session.displayName ?? session.name;
  const label = t('shell', 'account.menu');
  const signOut = () => document.querySelector<HTMLFormElement>(`#${signOutFormId}`)?.requestSubmit();
  return (
    <div className="pb-account">
      <Menu.Root>
        <Menu.Trigger className="pb-account__trigger">
          <AccountName name={name} label={label} />
        </Menu.Trigger>
        <Menu.Popup placement="bottom-end">
          <Menu.List aria-label={label}>
            {accountPages(session, t).map(({ id, href, label }) => (
              <Menu.Item key={id} id={id} onAction={() => openInRouter(router, href)}>
                {label}
              </Menu.Item>
            ))}
            <Menu.Separator />
            <Menu.Item id="sign-out" onAction={signOut}>
              {t('shell', 'account.signOut')}
            </Menu.Item>
          </Menu.List>
        </Menu.Popup>
      </Menu.Root>
      <Link className="pb-account__trigger pb-account__no-script pb-link-quiet" href={`#${accountLinksId}`}>
        <AccountName name={name} label={label} />
      </Link>
    </div>
  );
}

/**
 * The account's pages and sign-out as plain links and a form, at the foot of every page for a
 * signed-in viewer. Shown only with scripts off (shell.css), where the account menu cannot open;
 * otherwise it is not displayed, and its form is the one the menu's Sign out submits.
 */
export function AccountLinks({ session }: { session: SessionView }) {
  const { t } = useTranslate();
  return (
    <nav id={accountLinksId} className="pb-account-links" aria-label={t('shell', 'account.menu')}>
      {accountPages(session, t).map(({ id, href, label }) => (
        <Link key={id} className="pb-link-quiet" href={href}>
          {label}
        </Link>
      ))}
      {/* The form stays empty and hidden, as the menu's was: its button is outside it (the form
          attribute), so a page's own `form button[type=submit]` is still the page's only one. */}
      <form id={signOutFormId} method="post" action={signOutAction} hidden />
      <Button type="submit" form={signOutFormId} variant="neutral" size="sm">
        {t('shell', 'account.signOut')}
      </Button>
    </nav>
  );
}
