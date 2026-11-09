import { createFileRoute } from '@tanstack/react-router';
import { FeedPage } from './index/-feed/feed-page.tsx';
import { feedRoute } from './index/-feed/route.ts';

// The front page: Subscribed for a signed-in person, Local for anyone else. The five feeds
// share one page (index/-feed); this file and its siblings only say which feed they are.
export const Route = createFileRoute('/')({
  ...feedRoute('home'),
  component: Home,
});

function Home() {
  return <FeedPage path="/" data={Route.useLoaderData()} search={Route.useSearch()} />;
}
