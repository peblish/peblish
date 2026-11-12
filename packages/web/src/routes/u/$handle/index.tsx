import { createFileRoute, notFound } from '@tanstack/react-router';
import { translate } from '../../../i18n/translate.ts';
import { titleContext } from './-head.ts';
import { loadProfile } from './-load.ts';
import { parseProfileSearch, resolveProfileSearch } from './-search.ts';
import { ProfilePage } from './-ui/profile-page.tsx';
import profileCss from './-ui/profile.css?url';
import { ownTitle } from '../../../shell/title.ts';

// /u/<handle> (profile-side): a person's card beside their posts and comments. The same address
// is the person's ActivityPub id, which federation answers first (README, web rules). Public;
// what the viewer sees of the person (blocked, tools) is personal, so the loader says no-store.

export const Route = createFileRoute('/u/$handle/')({
  validateSearch: parseProfileSearch,
  loaderDeps: ({ search }) => resolveProfileSearch(search),
  loader: async ({ params, deps }) => {
    const data = await loadProfile({
      data: { handle: params.handle, tab: deps.tab, sort: deps.sort, ...(deps.after ? { after: deps.after } : {}) },
    });
    if (!data) throw notFound();
    return data;
  },
  head: (context) => {
    const { loaderData, matches } = context;
    const { locale, site } = titleContext(matches);
    return {
      meta: [
        ...ownTitle(
          context,
          loaderData &&
            `${translate(locale, 'profiles', 'title', { name: loaderData.person.displayName || loaderData.person.name, handle: `@${loaderData.person.handle}` })} · ${site}`,
        ),
        // A person who opted out of search stays out of it.
        ...(loaderData && (!loaderData.indexable || loaderData.state === 'deleted') ? [{ name: 'robots', content: 'noindex' }] : []),
      ],
      links: [{ rel: 'stylesheet', href: profileCss }],
    };
  },
  component: Profile,
});

function Profile() {
  return <ProfilePage data={Route.useLoaderData()} />;
}
