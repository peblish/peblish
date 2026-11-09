import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

// Shared by the tabs of one browser: who the page loaded last was rendered for. The session
// cookie itself is HttpOnly, so a tab cannot read it; every page load leaves this behind instead.
const KEY = 'pb-viewer';

/** localStorage can be blocked or throw (private windows, cleared site data): the sync is then off, and the page is unaffected. */
function latestViewer(record?: string): string | null {
  try {
    if (record !== undefined) localStorage.setItem(KEY, record);
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * Keeps a tab's shell in step with the account the browser is signed in as. The root loader's
 * data (the viewer and the sidebar) is kept for good (staleTime Infinity), so a tab left open
 * while another tab signs in, signs out or switches account would keep showing the previous
 * viewer. This records the viewer each time the root data loads, and when the tab becomes
 * visible again and the browser's latest viewer is someone else, reloads the page's data.
 * `viewer` is the actor id of the signed-in person, or '' when signed out.
 */
export function useViewerSync(viewer: string): void {
  const router = useRouter();
  useEffect(() => {
    latestViewer(viewer);
    function onVisible() {
      const latest = latestViewer();
      if (document.visibilityState === 'visible' && latest !== null && latest !== viewer) void router.invalidate();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [router, viewer]);
}
