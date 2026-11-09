import type { Prefs } from '@peblish/core/prefs/cookie';
import { applyScheme } from '@peblish/ui/theme/root';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
 * does not outlive the page).
 */
export function PrefsProvider({ initial, children }: { initial: Prefs; children: ReactNode }) {
  const [prefs, setState] = useState(initial);

  const setPrefs = useCallback((change: Partial<Prefs>) => {
    setState((current) => ({ ...current, ...change }));
    storePrefs({ data: change }).catch(() => undefined);
  }, []);

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
