import { FeedSkeleton, InboxSkeleton, RailSkeleton, ThreadSkeleton } from '@peblish/ui/skeleton/skeletons';
import type { ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { usePrefs } from './prefs.tsx';
import { Rail } from './rail.tsx';
import { ViewHeader } from './view-header.tsx';

/**
 * A route's loading host (Commons, the mock's notes/loading.md): while a page's data takes longer than the
 * router's pending delay, the frame stays and the page's <main> is busy, holding the skeleton of what is
 * coming, whose one status says what is loading. Only a navigation in the browser shows one: the server
 * waits for the data. A route that draws its own view header (`viewHeader: 'own'`) draws it in its host
 * too, from what it knows before its data, with the app's own styles only (its page's stylesheet comes with
 * the page): the shell leaves its default bar out while it loads. A page that arrives with a rail has its
 * blocks in the host, so the centre keeps its place.
 */
function Pending({ className, children }: { className: string; children: ReactNode }) {
  return (
    <main className={className} aria-busy="true">
      {children}
    </main>
  );
}

/**
 * A feed's rows, in the viewer's density, under `header` (a feed's own bar, index/-feed/feed-pending.tsx),
 * and the rail's blocks (a feed and a profile both have a rail).
 */
export function FeedPending({ header }: { header?: ReactNode }) {
  const { t } = useTranslate();
  const { prefs } = usePrefs();
  return (
    <>
      <Pending className="pb-page">
        {header}
        <div className="pb-rows">
          <FeedSkeleton density={prefs.density} label={t('shell', 'loading.posts')} />
        </div>
      </Pending>
      <Rail label={t('shell', 'loading.posts')}>
        <RailSkeleton />
      </Rail>
    </>
  );
}

/**
 * A post and the first screen of its thread, under the post page's bar (its community comes with the post),
 * and the rail's blocks.
 */
export function PostPending() {
  const { t } = useTranslate();
  return (
    <>
      <ViewHeader />
      <Pending className="pb-page">
        <ThreadSkeleton label={t('shell', 'loading.post')} />
      </Pending>
      <Rail label={t('shell', 'loading.post')}>
        <RailSkeleton />
      </Rail>
    </>
  );
}

/** The inbox's notices, under its bar (Mark all read comes with them). */
export function InboxPending() {
  const { t } = useTranslate();
  return (
    <Pending className="pb-inbox">
      <ViewHeader root quiet />
      <div className="pb-page pb-inbox__body">
        <InboxSkeleton label={t('shell', 'loading.inbox')} />
      </div>
    </Pending>
  );
}
