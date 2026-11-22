import { FeedSkeleton, InboxSkeleton, ThreadSkeleton } from '@peblish/ui/skeleton/skeletons';
import type { ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { usePrefs } from './prefs.tsx';

/**
 * A route's loading host (Commons, the mock's notes/loading.md): while a page's data takes longer than the
 * router's pending delay, the frame stays and the page's <main> is busy, holding the skeleton of what is
 * coming, whose one status says what is loading. Only a navigation in the browser shows one: the server
 * waits for the data.
 */
function Pending({ className, children }: { className: string; children: ReactNode }) {
  return (
    <main className={className} aria-busy="true">
      {children}
    </main>
  );
}

/** A feed's rows, in the viewer's density. */
export function FeedPending() {
  const { t } = useTranslate();
  const { prefs } = usePrefs();
  return (
    <Pending className="pb-page">
      <div className="pb-rows">
        <FeedSkeleton density={prefs.density} label={t('shell', 'loading.posts')} />
      </div>
    </Pending>
  );
}

/** A post and the first screen of its thread. */
export function PostPending() {
  const { t } = useTranslate();
  return (
    <Pending className="pb-page">
      <ThreadSkeleton label={t('shell', 'loading.post')} />
    </Pending>
  );
}

/** The inbox's notices. */
export function InboxPending() {
  const { t } = useTranslate();
  return (
    <Pending className="pb-page pb-inbox">
      <InboxSkeleton label={t('shell', 'loading.inbox')} />
    </Pending>
  );
}
