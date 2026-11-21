import { CommunityListSkeleton } from '@peblish/ui/components/community-list';
import { RailSkeleton } from '@peblish/ui/skeleton/skeletons';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { Rail } from '../../../shell/rail.tsx';
import { parseViewCookie } from '../-view.ts';

/**
 * The directory's loading host (the mock's DirectorySkeleton): a busy <main> holding rows or cards in
 * the view this browser chose, and the rail's blocks, with one status saying what is loading. It only
 * shows on a navigation in the browser, so it reads the view from the page's own cookie.
 */
export function DirectoryPending() {
  const { t } = useTranslate();
  const view = parseViewCookie(typeof document === 'undefined' ? undefined : document.cookie);
  return (
    <>
      <main className="pb-page dir" aria-busy="true">
        <CommunityListSkeleton view={view} label={t('directory', 'directory.loading')} />
      </main>
      <Rail label={t('directory', 'directory.loading')}>
        <RailSkeleton />
      </Rail>
    </>
  );
}
