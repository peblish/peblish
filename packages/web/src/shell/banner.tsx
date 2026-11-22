import type { SiteBanner as SiteBannerSetting } from '@peblish/schema/banner';
import { SiteBanner } from '@peblish/ui/components/site-banner';
import { useRouter } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';

// The site banner's slot in the frame (shell.tsx): the published `site.banner`, unless this browser
// dismissed its revision. The dismissal is a cookie of the shell's own, read by the root loader, so the
// server leaves a dismissed banner out and hydration moves nothing; a new revision shows it again.

export const bannerCookieName = 'peblish_banner';

/** The revision this browser dismissed, from a Cookie header; null when there is none. */
export function parseBannerCookie(cookieHeader: string | null | undefined): number | null {
  const raw = cookieHeader
    ?.split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${bannerCookieName}=`))
    ?.slice(bannerCookieName.length + 1);
  return raw && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

const oneYear = 365 * 24 * 60 * 60;

function store(revision: number | null) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${bannerCookieName}=${revision ?? ''}; Path=/; Max-Age=${revision === null ? 0 : oneYear}; SameSite=Lax${secure}`;
}

// What this page did since it loaded (dismissed it, or showed it again from the admin form), over the
// cookie the root loader read, which stays as it was until the next document.
let local: { revision: number; dismissed: boolean } | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const set = (next: typeof local) => {
  local = next;
  listeners.forEach((listener) => listener());
};

/** Whether this browser has dismissed `revision`, given the revision the root loader read from the cookie. */
export function useBannerDismissed(revision: number, cookieRevision: number | null): boolean {
  const mine = useSyncExternalStore(
    subscribe,
    () => local,
    () => null,
  );
  return mine?.revision === revision ? mine.dismissed : cookieRevision === revision;
}

export function dismissBanner(revision: number) {
  store(revision);
  set({ revision, dismissed: true });
}

/** Shows a dismissed banner again in this browser (the admin form's "Show banner again"). */
export function showBannerAgain(revision: number) {
  store(null);
  set({ revision, dismissed: false });
}

/**
 * The banner under the header, full width, above the sidebar and the page; on a phone, at the top of the
 * page above its bar. Dismissing it moves focus to the page's main region, without scrolling.
 */
export function ShellBanner({ banner, cookieRevision }: { banner: SiteBannerSetting | null; cookieRevision: number | null }) {
  const { t } = useTranslate();
  const router = useRouter();
  const dismissed = useBannerDismissed(banner?.revision ?? 0, cookieRevision);
  if (!banner?.enabled || dismissed) return null;
  return (
    <SiteBanner
      className="pb-app__banner"
      banner={banner}
      label={t('shell', 'banner.label')}
      dismissLabel={t('shell', 'banner.dismiss')}
      onNavigate={(href) => void router.navigate({ href })}
      onDismiss={() => {
        dismissBanner(banner.revision);
        const target = document.querySelector<HTMLElement>('#pb-main main') ?? document.getElementById('pb-main');
        if (target && !target.hasAttribute('tabindex')) target.tabIndex = -1;
        target?.focus({ preventScroll: true });
      }}
    />
  );
}
