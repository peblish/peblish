import { communityGate } from '@peblish/core/communities/page';
import { findCommunityId } from '@peblish/core/communities/read';
import type { Viewer } from '@peblish/core/posts/read';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../../server/auth.ts';
import { communityPath } from '../../../shell/paths.ts';
import { gateData, requestNsfw } from '../-gate.ts';
import { communityPost } from '../-intents.ts';
import { GateNotice } from '../-ui/gate.tsx';
import gateCss from '../-ui/gate.css?url';

const Search = type({ 'error?': 'string' });

const loadCommunity = createServerFn({ method: 'GET' })
  .validator(type({ handle: 'string' }))
  .handler(async ({ data }) => {
    const session = await pageSession();
    const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
    const id = await findCommunityId(data.handle);
    const gate = id && (await communityGate(id, viewer, requestNsfw()));
    if (!gate) return null;
    if (gate !== 'none') return gateData({ subject: 'community', gate, handle: data.handle, back: communityPath({ handle: data.handle }) });
    return { kind: 'page' as const, handle: data.handle };
  });

export const Route = createFileRoute('/c/$handle/')({
  validateSearch: Search,
  loader: async ({ params }) => {
    const data = await loadCommunity({ data: { handle: params.handle } });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({
    meta: loaderData?.kind === 'gate' ? [{ name: 'robots', content: 'noindex' }] : [],
    links: [{ rel: 'stylesheet', href: gateCss }],
  }),
  component: CommunityRoute,
  server: { handlers: { POST: ({ request, params }) => communityPost(request, params.handle) } },
});

function CommunityRoute() {
  const data = Route.useLoaderData();
  const { error } = Route.useSearch();
  return data.kind === 'gate' ? <GateNotice data={data} error={error} /> : <main>{data.handle}</main>;
}
