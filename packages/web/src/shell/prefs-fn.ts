import { publicOrigin } from '@peblish/core/config';
import { Prefs, prefsSetCookie } from '@peblish/core/prefs/cookie';
import { createServerFn } from '@tanstack/react-start';
import { appendResponseHeader, getRequest } from '@tanstack/react-start/server';
import { sameOrigin } from '../server/auth.ts';

/**
 * Stores the viewer's complete display preferences in the cookie. The client sends all of them
 * (never a change to merge against the request's own cookie), one request at a time, so a
 * save that arrives late cannot restore an older value of the other field.
 */
export const storePrefs = createServerFn({ method: 'POST' })
  .validator(Prefs)
  .handler(({ data }) => {
    if (!sameOrigin(getRequest())) throw new Error('cross-site request refused');
    appendResponseHeader('set-cookie', prefsSetCookie(data, { secure: publicOrigin()?.startsWith('https:') ?? false }));
    return data;
  });
