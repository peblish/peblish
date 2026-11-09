import { PlusIcon } from '@peblish/ui/components/icons';
import { useRouterState } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { createPostPath } from './paths.ts';

// The sheet's code (the dialog, the editor, the form) loads when the sheet is first opened, so
// no page pays for it before then; pointing at the link or focusing it starts the load early.
// Lane COMPOSER owns this module.
const loadSheet = () => import('../routes/submit/-ui/composer-sheet.tsx');
const ComposerSheet = lazy(loadSheet);

/** The community whose page is open (`/c/<handle>`), so the sheet starts in it. */
const communityOf = (pathname: string) => {
  const handle = /^\/c\/([^/]+)/.exec(pathname)?.[1];
  return handle === undefined ? undefined : decodeURIComponent(handle);
};

/**
 * The "Create post" entry in the top bar. A link to the composer page, which is what it is
 * without JavaScript or with a modified click (a new tab); otherwise it opens the composer as a
 * bottom sheet over the page, which stays mounted underneath (composer-page).
 */
export function CreatePost() {
  const { t } = useTranslate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The sheet is open for the page it was opened on: a navigation closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  return (
    <>
      <a
        className="pb-create"
        href={createPostPath}
        onPointerEnter={() => void loadSheet()}
        onFocus={() => void loadSheet()}
        onClick={(event) => {
          const modified = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
          // On the composer's own page there is nothing to open over.
          if (modified || event.defaultPrevented || pathname.startsWith(createPostPath)) return;
          event.preventDefault();
          setOpenAt(pathname);
        }}
      >
        <PlusIcon />
        <span>{t('shell', 'create')}</span>
      </a>
      {open && (
        <Suspense fallback={null}>
          <ComposerSheet community={communityOf(pathname)} onClose={() => setOpenAt(null)} />
        </Suspense>
      )}
    </>
  );
}
