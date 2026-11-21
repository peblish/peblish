import { createFileRoute, notFound } from '@tanstack/react-router';
import { DEFAULT_LOCALE } from '../i18n/negotiate.ts';
import { headTitle, ownTitle, rootTitleData } from '../shell/title.ts';
import { LegalPage } from './-legal/legal-page.tsx';
import legalCss from './-legal/legal.css?url';
import { loadLegalPage } from './-legal/load.ts';

// /<slug>: the instance's own pages (terms, privacy, rules, about and the other legal texts), from
// the CMS pages lane ADM's admin Pages tab publishes. Only the fixed slugs answer; any other single
// segment, and a page nobody has published, is the ordinary 404. Static routes (/all, /local, ...)
// match before this one.
export const Route = createFileRoute('/$slug')({
  loader: async ({ params }) => {
    const data = await loadLegalPage({ data: { slug: params.slug } });
    if (!data) throw notFound();
    return data;
  },
  head: (context) => {
    const { loaderData, matches } = context;
    const { site } = rootTitleData(matches.find((match) => (match.routeId as string) === '__root__')?.loaderData, DEFAULT_LOCALE);
    // A published page by its own title; /about with none published is the instance's details,
    // titled as the sidebar link that leads there (its heading, "About <site>", already names the site).
    const title = loaderData?.page
      ? ownTitle(context, `${loaderData.page.title} · ${site}`)
      : loaderData?.about
        ? headTitle(context, 'shell', 'footer.about')
        : [];
    return { meta: title, links: [{ rel: 'stylesheet', href: legalCss }] };
  },
  component: Legal,
});

function Legal() {
  return <LegalPage data={Route.useLoaderData()} />;
}
