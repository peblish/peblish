import { useCallback, useEffect, useState } from 'react';

// Whether the sidebar is open or folded into its icon rail (Commons). The viewer's choice is kept in a
// cookie of the shell's own, so the server draws the page with it and a reload moves nothing. Until
// they choose, the sidebar follows the window, folded below WIDE_AT, and the cookie remembers how the
// window was last time: only the first visit from a narrow window is drawn open and then folds.

/** The window width from which the open sidebar (16rem) still leaves the centre and the right rail their room. */
export const WIDE_AT = 1264;

export const sideCookieName = 'peblish_side';

/** The viewer's choice ('open' or 'rail'), else how the window was when last seen ('narrow', or '' for wide). */
export type SideCookie = 'open' | 'rail' | 'narrow' | '';

const oneYear = 365 * 24 * 60 * 60;
const chosen = (value: SideCookie) => value === 'open' || value === 'rail';

/** The cookie's value, read from a Cookie header; anything else is ''. */
export function parseSideCookie(cookieHeader: string | null | undefined): SideCookie {
  const raw = cookieHeader
    ?.split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${sideCookieName}=`))
    ?.slice(sideCookieName.length + 1);
  return raw === 'open' || raw === 'rail' || raw === 'narrow' ? raw : '';
}

/** Whether the server draws the sidebar folded for this cookie. */
export const foldedFor = (value: SideCookie) => value === 'rail' || value === 'narrow';

/** Stores the value for a year ('' clears it). A display choice only, so the page writes it itself. */
function store(value: SideCookie) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${sideCookieName}=${value}; Path=/; Max-Age=${value ? oneYear : 0}; SameSite=Lax${secure}`;
}

/**
 * The sidebar's fold for Sidebar.Provider, starting from the cookie the root loader read (`initial`),
 * so the first render matches the server's. After hydration, while the viewer has not chosen, it
 * follows the window across WIDE_AT; `setCollapsed` is the viewer's choice, kept from then on.
 */
export function useSideFold(initial: SideCookie): { collapsed: boolean; setCollapsed: (collapsed: boolean) => void } {
  const [value, setValue] = useState(initial);
  const isChosen = chosen(value);

  useEffect(() => {
    if (isChosen) return;
    const wide = matchMedia(`(min-width: ${WIDE_AT}px)`);
    // The cookie is what this keeps in step with the window, so it is read rather than the state.
    const follow = () => {
      const stored = parseSideCookie(document.cookie);
      if (chosen(stored)) return;
      const next: SideCookie = wide.matches ? '' : 'narrow';
      if (next !== stored) store(next);
      setValue(next);
    };
    follow();
    wide.addEventListener('change', follow);
    return () => wide.removeEventListener('change', follow);
  }, [isChosen]);

  const setCollapsed = useCallback((collapsed: boolean) => {
    const next: SideCookie = collapsed ? 'rail' : 'open';
    store(next);
    setValue(next);
  }, []);

  return { collapsed: foldedFor(value), setCollapsed };
}
