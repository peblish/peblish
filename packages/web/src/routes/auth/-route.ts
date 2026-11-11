import { notFound } from '@tanstack/react-router';
import { type } from 'arktype';
import authCss from './-ui/auth.css?url';

// Route options shared by the auth, invite, settings and admin routes. TanStack keeps a route's
// head, beforeLoad and validateSearch in the client entry, so they live here, away from any
// component: importing them from a component module loaded its Mux parts on every page.

/** The stylesheet every lane A page links (route head). */
export const authHead = () => ({ links: [{ rel: 'stylesheet', href: authCss }] });

/**
 * A search value as a string: TanStack Router parses ?a=1 into a number, so values that can
 * look numeric (tokens, flags) are taken either way.
 */
export const SearchText = type('string | number').pipe((value) => String(value));

/**
 * A route group's beforeLoad (routes/{auth,invite,settings,admin}/route.tsx): the group's own
 * path has no page, so /settings answers 404 like any unknown path, not an empty layout.
 */
export const noGroupPage =
  (group: string) =>
  ({ location }: { location: { pathname: string } }) => {
    if (location.pathname.replace(/\/+$/, '') === group) throw notFound();
  };
