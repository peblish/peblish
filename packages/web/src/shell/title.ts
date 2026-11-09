import { translate, type MessageKey } from '../i18n/translate.ts';

// The page title convention: "<page> · peblish", or just "peblish" for a page with no name.
// The root route (routes/__root.tsx) gives every page a title from the table below, keyed by
// its route id; a route that needs a dynamic title (a post, a community) sets its own in its
// `head`, calling pageTitle(), and that one wins.

/** A page's title in the locale; `name` is a message in the shell catalogue. */
export function pageTitle(locale: string, name?: MessageKey<'shell'>): string {
  const site = translate(locale, 'shell', 'title');
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
  '/admin/registration/': 'page.invites',
  '/kit/': 'page.kit',
};

export function titleForRoute(locale: string, routeId: string | undefined): string {
  return pageTitle(locale, routeId === undefined ? undefined : routeTitles[routeId]);
}
