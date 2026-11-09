import { createFileRoute } from '@tanstack/react-router';
import { FeedPage } from '../index/-feed/feed-page.tsx';
import { feedRoute } from '../index/-feed/route.ts';

export const Route = createFileRoute('/popular/')({
  ...feedRoute('popular', 'feed.popular'),
  component: PopularRoute,
});

function PopularRoute() {
  return <FeedPage path="/popular" data={Route.useLoaderData()} search={Route.useSearch()} />;
}
