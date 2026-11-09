import { maxLookupLength } from '@peblish/core/resolve/outcome';
import { createFileRoute } from '@tanstack/react-router';
import { type } from 'arktype';
import { DEFAULT_LOCALE } from '../../i18n/negotiate.ts';
import { translate } from '../../i18n/translate.ts';
import { clientIp, forbidden, formSession, privateResponses, sameOrigin } from '../../server/auth.ts';
import directoryCss from '../communities/-ui/directory.css?url';
import { answer } from './-answer.ts';
import { loadResolve } from './-load.ts';
import { resolveForm } from './-resolve.ts';
import { ResolvePage } from './-ui/resolve-page.tsx';

// /resolve: find a community, person, post or comment on another server by handle or link. The
// page is public and its form is for signed-in accounts; a GET never fetches anything.

/** A search value as a string: the router parses ?a=1 into a number. */
const Text = type('string | number').pipe((value) => String(value));
const Search = type({ 'q?': Text, 'error?': Text });

export const Route = createFileRoute('/resolve/')({
  validateSearch: Search,
  loader: async ({ parentMatchPromise }) => {
    const [data, root] = await Promise.all([loadResolve(), parentMatchPromise]);
    const locale = root.loaderData?.locale ?? DEFAULT_LOCALE;
    return { ...data, title: `${translate(locale, 'directory', 'resolve.title')} · ${root.loaderData?.shell.siteName ?? ''}` };
  },
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: loaderData.title }] : [],
    links: [{ rel: 'stylesheet', href: directoryCss }],
  }),
  component: ResolveRoute,
  // What it answers depends on who asks, and a typed address may be private: never from a shared cache.
  server: {
    middleware: [privateResponses],
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const q = ((await request.formData()).get('q') ?? '').toString().slice(0, maxLookupLength + 1);
        const who = session ? { actorId: session.view.actorId, emailVerified: session.view.emailVerified, ip: clientIp(request) } : null;
        return answer(request, cookies, await resolveForm(who, q), q.trim().slice(0, maxLookupLength));
      },
    },
  },
});

function ResolveRoute() {
  const { signedIn } = Route.useLoaderData();
  const { q, error } = Route.useSearch();
  return <ResolvePage signedIn={signedIn} q={q?.slice(0, maxLookupLength) ?? ''} error={error} />;
}
