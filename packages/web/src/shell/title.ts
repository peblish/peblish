import { translate, type MessageKey } from '../i18n/translate.ts';

// The page title convention: "<page> · <site>", or just "<site>" for a page with no name. The
// site is the instance's name from its settings (site.name), else its host: never a software
// name (ShellData.siteName). The root route (routes/__root.tsx) gives every page a title from
// the table below, keyed by its route id; a route that needs a dynamic title (a post, a
// community) sets its own in its `head`, calling pageTitle(), and that one wins.

/** A page's title in the locale; `name` is a message in the shell catalogue. */
export function pageTitle(locale: string, site: string, name?: MessageKey<'shell'>): string {
  return name ? `${translate(locale, 'shell', name)} · ${site}` : site;
}

/** Titles for routes that do not set their own, by route id (the generated route tree's ids). */
const routeTitles: Record<string, MessageKey<'shell'>> = {
  '/': 'home.title',
  '/auth/sign-in': 'page.signIn',
  '/auth/sign-up': 'page.signUp',
  '/auth/two-factor': 'page.twoFactor',
  '/auth/verify': 'page.verify',
  '/auth/reset': 'page.reset',
  '/invite/$code': 'page.invite',
  '/settings/account/': 'page.account',
  '/settings/security/': 'page.security',
  '/settings/blocks/': 'page.blocks',
  '/admin/registration/': 'page.invites',
  '/kit/': 'page.kit',
};

export function titleForRoute(locale: string, site: string, routeId: string | undefined): string {
  return pageTitle(locale, site, routeId === undefined ? undefined : routeTitles[routeId]);
}

/** The locale and the site name from the root route's loader data, as a route's `head` sees it in `matches`. */
export function rootTitleData(root: unknown, fallbackLocale: string): { locale: string; site: string } {
  const record = typeof root === 'object' && root !== null ? (root as Record<string, unknown>) : {};
  const shell = typeof record.shell === 'object' && record.shell !== null ? (record.shell as Record<string, unknown>) : {};
  return {
    locale: typeof record.locale === 'string' ? record.locale : fallbackLocale,
    site: typeof shell.siteName === 'string' ? shell.siteName : '',
  };
}
