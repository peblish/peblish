import { createServerFn } from '@tanstack/react-start';
import { appendResponseHeader, getRequest } from '@tanstack/react-start/server';
import { sessionOf } from '../../server/auth.ts';

/**
 * The signed-in person for this request, or null: for any route's loader (the shell's
 * account menu, a composer's principal). Server functions live here, apart from
 * server/auth.ts, so a client import of this file never pulls core into the bundle.
 */
export const getSessionView = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await sessionOf(getRequest());
  for (const cookie of session?.setCookies ?? []) appendResponseHeader('set-cookie', cookie);
  return session?.view ?? null;
});
