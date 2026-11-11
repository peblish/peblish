import { DEFAULT_LOCALE } from '../../../i18n/negotiate.ts';
import { translate, type MessageKey } from '../../../i18n/translate.ts';
import { rootTitleData } from '../../../shell/title.ts';

/**
 * An admin route's head: the title "<page> · <site>" (the shell's table has no entry for these
 * routes, so each names its own). Its own module, with no component in it: a route's head stays
 * in the client entry (see `auth/-route.ts`).
 */
export const adminHead =
  (title: MessageKey<'admin'>) =>
  ({ matches }: { matches: readonly { routeId: string; loaderData?: unknown }[] }) => {
    const { locale, site } = rootTitleData(matches.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
    return { meta: [{ title: `${translate(locale, 'admin', title)} · ${site}` }] };
  };
