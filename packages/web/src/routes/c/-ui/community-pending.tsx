import { FeedSkeleton, RailSkeleton } from '@peblish/ui/skeleton/skeletons';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { usePrefs } from '../../../shell/prefs.tsx';
import { Rail } from '../../../shell/rail.tsx';

/**
 * The community page's loading host (the mock's notes/loading.md): a busy <main> holding the posts'
 * rows in the viewer's density, and the rail's blocks, with one status saying what is loading.
 */
export function CommunityPending() {
  const { t } = useTranslate();
  const { prefs } = usePrefs();
  return (
    <>
      <main className="pb-page cm-page" aria-busy="true">
        <div className="pb-rows">
          <FeedSkeleton density={prefs.density} label={t('communities', 'page.loading')} />
        </div>
      </main>
      <Rail label={t('communities', 'page.loading')}>
        <RailSkeleton />
      </Rail>
    </>
  );
}
