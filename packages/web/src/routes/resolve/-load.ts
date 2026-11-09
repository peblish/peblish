import { createServerFn } from '@tanstack/react-start';
import { pageSession } from '../../server/auth.ts';

/**
 * The resolve page's data: only whether someone is signed in. A GET never fetches anything from
 * another server; that is the POST's work, after the checks in -resolve.ts.
 */
export const loadResolve = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await pageSession();
  return { signedIn: session !== null };
});
