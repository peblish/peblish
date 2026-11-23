import { readSetting } from '@peblish/core/settings/read';
import type { SiteBanner } from '@peblish/schema/banner';
import type { SiteWidth } from '@peblish/schema/site-settings';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { useEffect, useState } from 'react';

// The banner and the width are in the root loader's data, which a tab keeps for as long as it is open
// (__root.tsx, staleTime Infinity). So that an open tab does not show an old banner or width for ever, the shell
// asks for these two alone again when the tab comes back into use (focus, or shown again) at least
// RECHECK_AFTER since it last had them: one small GET reading two settings rows, never on a navigation.

/** The part of the shell's data an admin changes for everyone: the banner while it is on (else null), and the width. */
export interface SiteLook {
  banner: SiteBanner | null;
  width: SiteWidth;
}

export const RECHECK_AFTER = 5 * 60_000;

export const getSiteLook = createServerFn({ method: 'GET' }).handler(async (): Promise<SiteLook> => {
  setResponseHeader('cache-control', 'no-store');
  const [banner, width] = await Promise.all([readSetting('site.banner'), readSetting('site.width')]);
  return { banner: banner.enabled ? banner : null, width };
});

/** The banner and width to draw: the root loader's (`initial`), then what a later recheck brought. */
export function useSiteLook(initial: SiteLook): SiteLook {
  const [fresh, setFresh] = useState<{ from: SiteLook; look: SiteLook } | null>(null);
  useEffect(() => {
    let checkedAt = Date.now();
    const recheck = () => {
      if (document.visibilityState !== 'visible' || Date.now() - checkedAt < RECHECK_AFTER) return;
      checkedAt = Date.now();
      getSiteLook().then(
        (look) => setFresh({ from: initial, look }),
        () => undefined,
      );
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [initial]);
  // A root reload (router.invalidate) brings newer data than an older recheck.
  return fresh?.from === initial ? fresh.look : initial;
}
