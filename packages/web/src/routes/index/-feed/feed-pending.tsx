import { Text } from '@peblish/ui/components/text';
import { getRouteApi } from '@tanstack/react-router';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { FeedPending } from '../../../shell/pending.tsx';
import { ViewHeader } from '../../../shell/view-header.tsx';
import { feedTitleKeys, routeFeed } from './names.ts';
import type { FeedRoute } from './route.ts';

const root = getRouteApi('__root__');

/**
 * A feed's loading host: the feed's own view header with its name, as its page draws it but for the glyph
 * and the menus, which come with the page (and its stylesheet, which a loading page may not have yet), over
 * the rows' shapes, so the frame's default bar never shows while a feed loads.
 */
export function feedPending(route: FeedRoute) {
  return function FeedPagePending() {
    const { t } = useTranslate();
    const { session } = root.useLoaderData();
    const title = (
      <Text as="h1" variant="label" truncate className="pb-frame-vh__title">
        {t('shell', feedTitleKeys[routeFeed(route, session !== null)])}
      </Text>
    );
    return <FeedPending header={<ViewHeader root title={title} />} />;
  };
}
