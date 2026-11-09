import type { Prefs } from '@peblish/core/prefs/cookie';
import { applyScheme } from '@peblish/ui/theme/root';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { latestSaver } from './latest-saver.ts';
import { storePrefs } from './prefs-fn.ts';

interface PrefsContext {
  prefs: Prefs;
  /** Changes the density or the scheme: it applies at once and is stored in the cookie. */
  setPrefs: (change: Partial<Prefs>) => void;
}

const Context = createContext<PrefsContext | null>(null);

/**
 * The display preferences for the page. `initial` is what the server read from the cookie,
 * so the first render is the right one; later changes are kept here, applied to <html> for
 * the scheme, and stored through a server function (a failed save only means the choice
 * does not outlive the page). Saves go out one at a time, each with the complete preferences,
 * so two quick changes (density, then scheme) cannot overwrite each other in the cookie.
 */
export function PrefsProvider({ initial, children }: { initial: Prefs; children: ReactNode }) {
  const [prefs, setState] = useState(initial);
  const latest = useRef(initial);
  const [save] = useState(() => latestSaver((all: Prefs) => storePrefs({ data: all })));

  const setPrefs = useCallback(
    (change: Partial<Prefs>) => {
      latest.current = { ...latest.current, ...change };
      setState(latest.current);
      save(latest.current);
    },
    [save],
  );

  // Keeps <html> in step with the choice; 'system' also follows the operating system live.
  useEffect(() => {
    applyScheme(prefs.scheme);
    if (prefs.scheme !== 'system') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const follow = () => applyScheme('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [prefs.scheme]);

  const value = useMemo(() => ({ prefs, setPrefs }), [prefs, setPrefs]);
  return <Context value={value}>{children}</Context>;
}

export function usePrefs(): PrefsContext {
  const context = use(Context);
  if (!context) throw new Error('usePrefs needs a PrefsProvider above it (routes/__root.tsx)');
  return context;
}
