import { createFileRoute } from '@tanstack/react-router';
import { FeedPage } from '../index/-feed/feed-page.tsx';
import { feedRoute } from '../index/-feed/route.ts';

export const Route = createFileRoute('/all/')({
  ...feedRoute('all', 'feed.all'),
  component: AllRoute,
});

function AllRoute() {
  return <FeedPage path="/all" data={Route.useLoaderData()} search={Route.useSearch()} />;
}
