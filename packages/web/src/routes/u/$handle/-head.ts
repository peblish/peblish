import { DEFAULT_LOCALE } from '../../../i18n/negotiate.ts';
import { rootTitleData } from '../../../shell/title.ts';

/** The locale and site name for a profile page's `head`, from the root route's loader data among the matches. */
export function titleContext(matches: readonly { routeId: string; loaderData?: unknown }[]) {
  return rootTitleData(matches.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
}
