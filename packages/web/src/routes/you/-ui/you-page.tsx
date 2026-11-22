import { Button } from '@peblish/ui/components/button';
import {
  ClipboardListIcon,
  FileTextIcon,
  HeartHandshakeIcon,
  InfoIcon,
  LockIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
  UserPlusIcon,
  UserRoundIcon,
  type IconProps,
} from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { toScheme } from '@peblish/ui/theme/root';
import { getRouteApi } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { accountPages, signOutFormId } from '../../../shell/account.tsx';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { reportQueuePath, sitePaths } from '../../../shell/paths.ts';
import { usePrefs } from '../../../shell/prefs.tsx';
import { ViewHeader } from '../../../shell/view-header.tsx';
import { AppearanceChoice, YouIdentity, YouLinks, type YouLink } from './you-parts.tsx';

const root = getRouteApi('__root__');

const accountIcons: Record<string, ComponentType<IconProps>> = {
  profile: UserRoundIcon,
  settings: SettingsIcon,
  security: ShieldCheckIcon,
  invites: UserPlusIcon,
  admin: ShieldIcon,
};

/**
 * /you (Commons' You tab): on a phone, what the header's account menu and the sidebar hold on a computer.
 * The viewer, then the account's pages (the moderation queue after Profile for a moderator or an admin),
 * Appearance, the site's own pages and Sign out, which submits the frame's one sign-out form (AccountLinks)
 * and so works with scripts off. A top destination: no Back.
 */
export function YouPage() {
  const { t } = useTranslate();
  const { session, shell } = root.useLoaderData();
  const { prefs, setPrefs } = usePrefs();
  const hydrated = useHydrated();
  useRouteHydrated();
  const title = t('shell', 'nav.you');
  const header = (
    <ViewHeader
      root
      title={
        <Text variant="label" truncate className="you-bar__title">
          {title}
        </Text>
      }
    />
  );
  // Signed out after the page loaded (another tab signed out): the loader sends a fresh visit to sign in.
  if (!session)
    return (
      <main className="pb-page you">
        {header}
        <Link href="/auth/sign-in?redirect=%2Fyou">{t('shell', 'account.signIn')}</Link>
      </main>
    );

  const [profile, ...rest] = accountPages(session, t).map(({ id, href, label }) => ({
    href,
    label,
    icon: accountIcons[id] ?? UserRoundIcon,
  }));
  const queue: YouLink[] =
    shell.reportCount !== null ? [{ href: reportQueuePath(), label: t('shell', 'you.queue'), icon: ClipboardListIcon }] : [];
  const account: YouLink[] = [...(profile ? [profile] : []), ...queue, ...rest];
  const site: YouLink[] = [
    { href: sitePaths.about, label: t('shell', 'footer.about'), icon: InfoIcon },
    { href: sitePaths.rules, label: t('shell', 'footer.conduct'), icon: HeartHandshakeIcon },
    { href: sitePaths.privacy, label: t('shell', 'footer.privacy'), icon: LockIcon },
    { href: sitePaths.terms, label: t('shell', 'footer.terms'), icon: FileTextIcon },
  ];
  return (
    <main className="pb-page you">
      {header}
      <div className="you-body">
        <YouIdentity name={session.displayName ?? session.name} initial={shell.initial} handle={session.name} />
        <YouLinks title={t('shell', 'account.menu')} links={account} />
        <AppearanceChoice value={toScheme(prefs.scheme)} onChange={(scheme) => setPrefs({ scheme })} disabled={!hydrated} />
        <YouLinks title={shell.siteName} links={site} />
        <div className="you-end">
          <Button type="submit" form={signOutFormId} variant="neutral">
            {t('shell', 'account.signOut')}
          </Button>
        </div>
      </div>
    </main>
  );
}
