import composerCss from '@peblish/ui/composer/composer.css?url';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { translate } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { EditForm } from './-ui/edit-form.tsx';
import { ProfileCard } from './-ui/profile-card.tsx';
import profileCss from './-ui/profile.css?url';
import { handleEditPost } from './-edit.ts';
import { titleContext } from './-head.ts';
import { loadEdit } from './-load.ts';
import { parseProfileSearch } from './-search.ts';

// /u/<handle>/edit (profile-edit-inline, R2b): the profile card stays on the left and the form
// replaces the activity. Display name and bio only; avatar, banner and the Bot switch come with
// uploads and bot accounts. Own profile only: signed out goes to sign in, someone else's to the
// profile.

export const Route = createFileRoute('/u/$handle/edit')({
  validateSearch: parseProfileSearch,
  loader: async ({ params }) => {
    const data = await loadEdit({ data: { handle: params.handle } });
    if (!data) throw notFound();
    return data;
  },
  head: ({ matches }) => {
    const { locale, site } = titleContext(matches);
    return {
      meta: [{ title: `${translate(locale, 'profiles', 'edit.title')} · ${site}` }, { name: 'robots', content: 'noindex' }],
      // The Markdown editor's own styles (its toolbar's 28 px targets among them), as the composer loads them.
      links: [composerCss, profileCss].map((href) => ({ rel: 'stylesheet', href })),
    };
  },
  component: Edit,
  server: { handlers: { POST: ({ request, params }) => handleEditPost(request, params.handle) } },
});

function Edit() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const { t } = useTranslate();
  useRouteHydrated();
  return (
    <main className="pb-page prof">
      <div className="prof-lay">
        <ProfileCard data={data.profile} />
        <section className="prof-main" aria-label={t('profiles', 'edit.editing')}>
          <EditForm data={data} saved={search.saved === true} error={search.error} />
        </section>
      </div>
    </main>
  );
}
