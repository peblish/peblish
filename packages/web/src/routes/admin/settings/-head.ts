import type { MessageKey } from '../../../i18n/translate.ts';
import { headTitle } from '../../../shell/title.ts';

/**
 * An admin route's head: the title "<page> · <site>" (the shell's table has no entry for these
 * routes, so each names its own). Its own module, with no component in it: a route's head stays
 * in the client entry (see `auth/-route.ts`).
 */
export const adminHead = (title: MessageKey<'admin'>) => (context: Parameters<typeof headTitle>[0]) => ({
  meta: headTitle(context, 'admin', title),
});
