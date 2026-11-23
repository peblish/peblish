import { createFileRoute } from '@tanstack/react-router';
import { headTitle } from '../../shell/title.ts';
import { loadInstances } from './-load.ts';
import { InstancesPage } from './-ui/instances-page.tsx';
import instancesCss from './-ui/instances.css?url';

// /instances: the public list of the servers this one federates with (Commons, branch 5), linked
// from the sidebar's site pages, the folded rail's site menu and the phone's You tab.
export const Route = createFileRoute('/instances/')({
  loader: () => loadInstances(),
  head: (context) => ({ meta: headTitle(context, 'facts', 'instances.title'), links: [{ rel: 'stylesheet', href: instancesCss }] }),
  component: Instances,
});

function Instances() {
  return <InstancesPage instances={Route.useLoaderData().instances} />;
}
