import { createFileRoute } from '@tanstack/react-router';
import { FeedPage } from '../index/-feed/feed-page.tsx';
import { feedRoute } from '../index/-feed/route.ts';

export const Route = createFileRoute('/moderating/')({
  ...feedRoute('moderating', 'feed.moderating'),
  component: ModeratingRoute,
});

function ModeratingRoute() {
  return <FeedPage path="/moderating" data={Route.useLoaderData()} search={Route.useSearch()} />;
}
