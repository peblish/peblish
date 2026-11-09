import { publicOrigin } from '@peblish/core/config';
import { parsePrefs, Prefs, prefsSetCookie } from '@peblish/core/prefs/cookie';
import { createServerFn } from '@tanstack/react-start';
import { appendResponseHeader, getRequest, getRequestHeader } from '@tanstack/react-start/server';
import { sameOrigin } from '../server/auth.ts';

/** Stores a change to the density or the scheme in the cookie; what is not named stays. */
export const storePrefs = createServerFn({ method: 'POST' })
  .validator(Prefs.partial())
  .handler(({ data }) => {
    if (!sameOrigin(getRequest())) throw new Error('cross-site request refused');
    const next = { ...parsePrefs(getRequestHeader('cookie')), ...data };
    appendResponseHeader('set-cookie', prefsSetCookie(next, { secure: publicOrigin()?.startsWith('https:') ?? false }));
    return next;
  });
