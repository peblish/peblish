import { isNotFound } from '@tanstack/react-router';
import { DEFAULT_LOCALE } from '../i18n/negotiate.ts';
import { translate, type Area, type MessageKey } from '../i18n/translate.ts';

// The page title convention: "<page> · <site>", or just "<site>" for a page with no name. The
// site is the instance's name from its settings (site.name), else its host: never a software
// name (ShellData.siteName). The root route (routes/__root.tsx) gives every page a title from
// the table below, keyed by its route id; a route that needs a dynamic title (a post, a
// community) sets its own in its `head`, calling pageTitle() or headTitle(), and that one wins.
// The not-found and error pages are named by the root too, whichever route they replace.

/** "<page> · <site>", or the page alone while the site is unknown (the root loader failed). */
const titled = (page: string, site: string) => (site ? `${page} · ${site}` : page);

/** A page's title in the locale; `name` is a message in the shell catalogue. */
export function pageTitle(locale: string, site: string, name?: MessageKey<'shell'>): string {
  return name ? titled(translate(locale, 'shell', name), site) : site;
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

/** A route match as a route's `head` sees it in `matches`. */
type HeadMatch = { routeId: string; loaderData?: unknown; status?: string; error?: unknown };

/**
 * The root's title for the page: the error page or the not-found page when one is shown in place
 * of a route, else the table's entry for the deepest route.
 */
export function titleForMatches(locale: string, site: string, matches: readonly HeadMatch[]): string {
  if (matches.some((match) => match.status === 'error')) return pageTitle(locale, site, 'error.title');
  // A not-found the root renders leaves the root match a success, holding the not-found as its error.
  if (matches.some((match) => match.status === 'notFound' || isNotFound(match.error))) return pageTitle(locale, site, 'notFound.title');
  return titleForRoute(locale, site, matches.at(-1)?.routeId);
}

export function titleForRoute(locale: string, site: string, routeId: string | undefined): string {
  return pageTitle(locale, site, routeId === undefined ? undefined : routeTitles[routeId]);
}

/**
 * A route head's title entry from a message in any area's catalogue, in the locale and with the
 * site name from the root's loader data: `head: ({ matches }) => ({ meta: [headTitle(matches, 'bans', 'title')] })`.
 */
export function headTitle<A extends Area>(
  matches: readonly HeadMatch[],
  area: A,
  key: MessageKey<A>,
  params?: Record<string, string | number>,
): { title: string } {
  const { locale, site } = rootTitleData(matches.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
  return { title: titled(translate(locale, area, key, params), site) };
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
