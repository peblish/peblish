import { isCommunityView, type CommunityView } from '@peblish/ui/components/community-list';

// The directory's List or Cards: a display choice kept in this browser, in a cookie of the directory's
// own, so the server draws the page in it and a reload moves nothing. The page writes it itself.

export const viewCookieName = 'peblish_dir_view';

const oneYear = 365 * 24 * 60 * 60;

/** The view a Cookie header names; List for anything else. */
export function parseViewCookie(cookieHeader: string | null | undefined): CommunityView {
  const raw = cookieHeader
    ?.split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${viewCookieName}=`))
    ?.slice(viewCookieName.length + 1);
  return isCommunityView(raw) ? raw : 'list';
}

/** Keeps the choice for a year; List, the default, clears it. */
export function storeView(view: CommunityView) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  const value = view === 'list' ? '' : view;
  document.cookie = `${viewCookieName}=${value}; Path=/; Max-Age=${value ? oneYear : 0}; SameSite=Lax${secure}`;
}
