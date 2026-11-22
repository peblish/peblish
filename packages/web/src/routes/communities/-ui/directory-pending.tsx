import { CommunityListSkeleton } from '@peblish/ui/components/community-list';
import { Text } from '@peblish/ui/components/text';
import { RailSkeleton } from '@peblish/ui/skeleton/skeletons';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { Rail } from '../../../shell/rail.tsx';
import { ViewHeader } from '../../../shell/view-header.tsx';
import { parseViewCookie } from '../-view.ts';

/**
 * The directory's loading host (the mock's DirectorySkeleton): a busy <main> holding the directory's own
 * view header and rows or cards in the view this browser chose, and the rail's blocks, with one status
 * saying what is loading. It only shows on a navigation in the browser, so it reads the view from the
 * page's own cookie.
 */
export function DirectoryPending() {
  const { t } = useTranslate();
  const view = parseViewCookie(typeof document === 'undefined' ? undefined : document.cookie);
  return (
    <>
      <main className="pb-page dir" aria-busy="true">
        <ViewHeader
          root
          title={
            <Text as="h1" variant="label" size="md" className="pb-frame-vh__title">
              {t('directory', 'directory.title')}
            </Text>
          }
        />
        <CommunityListSkeleton view={view} label={t('directory', 'directory.loading')} />
      </main>
      <Rail label={t('directory', 'directory.loading')}>
        <RailSkeleton />
      </Rail>
    </>
  );
}
