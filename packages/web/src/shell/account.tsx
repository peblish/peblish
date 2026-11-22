import type { SessionView } from '@peblish/schema/session';
import { Avatar } from '@peblish/ui/components/avatar';
import { Button } from '@peblish/ui/components/button';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { CheckIcon, LogInIcon, UserPlusIcon } from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Menu } from '@peblish/ui/components/menu';
import { Text } from '@peblish/ui/components/text';
import { schemes, toScheme } from '@peblish/ui/theme/root';
import { useRouter } from '@tanstack/react-router';
import { useTranslate } from '../i18n/use-translate.ts';
import { openInRouter } from './client-links.ts';
import { adminPaths, userPath } from './paths.ts';
import { usePrefs } from './prefs.tsx';

const signOutAction = '/auth/sign-out';
/** The account list at the foot of every page (AccountLinks), which the no-script Account link points at. */
const accountLinksId = 'pb-account-links';
/** The one sign-out form: in AccountLinks, submitted by its own button, the menu's Sign out or the phone drawer's. */
export const signOutFormId = 'pb-sign-out';

type Translate = ReturnType<typeof useTranslate>['t'];

/** The account's pages, in the menu's order: Invites and Admin for admins only. */
export function accountPages(session: SessionView, t: Translate) {
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

/**
 * The avatar, named "Account: <name>" for assistive technology, as the menu's button and the no-script link
 * show it. `initial` is the server's (ShellData.initial).
 */
function AccountName({ name, initial, label }: { name: string; initial: string; label: string }) {
  return (
    <>
      <Avatar.Root size="sm" aria-hidden="true">
        <Avatar.Fallback>{initial}</Avatar.Fallback>
      </Avatar.Root>
      <Text className="pb-sr">
        {label}: {name}
      </Text>
    </>
  );
}

/** Sign in and Sign up, for a visitor: in the desktop header. */
export function SignedOutActions() {
  const { t } = useTranslate();
  return (
    <nav className="pb-account" aria-label={t('shell', 'account.menu')}>
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

/**
 * The account menu of the desktop header (Commons): the viewer's avatar opens a Mux menu with their
 * pages, Appearance (System, Light, Dark; the current one ticked and called so, as Mux's Menu has no
 * checked items yet) and Sign out. Menu items are not links in Mux UI, so each page opens through the
 * router, and Sign out submits the real form in AccountLinks (posting to /auth/sign-out, which answers
 * with a redirect). The menu needs scripts: with none (`scripting: none`, shell.css) its button gives
 * way to a plain link, with the same look and name, to the account list at the foot of the page.
 */
export function Account({ session, initial }: { session: SessionView; initial: string }) {
  const { t } = useTranslate();
  const router = useRouter();
  const { prefs, setPrefs } = usePrefs();
  const scheme = toScheme(prefs.scheme);
  const name = session.displayName ?? session.name;
  const label = t('shell', 'account.menu');
  const signOut = () => document.querySelector<HTMLFormElement>(`#${signOutFormId}`)?.requestSubmit();
  return (
    <div className="pb-account">
      <Menu.Root>
        <Menu.Trigger className="pb-account__trigger">
          <AccountName name={name} initial={initial} label={label} />
        </Menu.Trigger>
        <Menu.Popup placement="bottom-end">
          <Menu.List aria-label={label}>
            {accountPages(session, t).map(({ id, href, label }) => (
              <Menu.Item key={id} id={id} onAction={() => openInRouter(router, href)}>
                {label}
              </Menu.Item>
            ))}
            <Menu.Separator />
            <Menu.Section title={t('shell', 'theme.menu')}>
              {schemes.map((choice) => (
                <Menu.Item
                  key={choice}
                  id={`scheme-${choice}`}
                  textValue={t('shell', `theme.${choice}`)}
                  onAction={() => setPrefs({ scheme: choice })}
                >
                  <span className="pb-account__choice">
                    <Text className="pb-account__choice-label">{t('shell', `theme.${choice}`)}</Text>
                    {/* Mux's Menu has no checked items yet: the tick, and "current" as the item's description, whose
                        element is always there, as React Aria looks for it only when the item mounts. */}
                    <Text slot="description" className="pb-sr">
                      {choice === scheme ? t('shell', 'theme.current') : ''}
                    </Text>
                    {choice === scheme && <CheckIcon className="pb-account__check" />}
                  </span>
                </Menu.Item>
              ))}
            </Menu.Section>
            <Menu.Separator />
            <Menu.Item id="sign-out" onAction={signOut}>
              {t('shell', 'account.signOut')}
            </Menu.Item>
          </Menu.List>
        </Menu.Popup>
      </Menu.Root>
      <Link className="pb-account__trigger pb-account__no-script pb-link-quiet" href={`#${accountLinksId}`}>
        <AccountName name={name} initial={initial} label={label} />
      </Link>
    </div>
  );
}

/**
 * The account's pages and sign-out as plain links and a form, at the foot of every page for a
 * signed-in viewer. Shown only with scripts off (shell.css), where the account menu and the phone
 * drawer cannot open; otherwise it is not displayed, and its form is the one their Sign out submits.
 * Named apart from the You page's own Account list, which it sits under there.
 */
export function AccountLinks({ session }: { session: SessionView }) {
  const { t } = useTranslate();
  return (
    <nav id={accountLinksId} className="pb-account-links" aria-label={t('shell', 'account.links')}>
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
