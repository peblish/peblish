import { createFileRoute } from '@tanstack/react-router';
import { FeedPage } from '../index/-feed/feed-page.tsx';
import { feedRoute } from '../index/-feed/route.ts';

export const Route = createFileRoute('/local/')({
  ...feedRoute('local', 'feed.local'),
  component: LocalRoute,
});

function LocalRoute() {
  return <FeedPage path="/local" data={Route.useLoaderData()} search={Route.useSearch()} />;
}
