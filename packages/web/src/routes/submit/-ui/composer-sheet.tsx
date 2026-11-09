import { ComposerSheet } from '@peblish/ui/composer/sheet';
import '@peblish/ui/composer/composer.css';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { openInRouter } from '../../../shell/client-links.ts';
import { loadComposer } from '../-load.ts';
import type { ComposerData } from '../-types.ts';
import { Composer } from './composer.tsx';
import './submit.css';

/**
 * The composer in the bottom sheet the shell's "Create post" opens over the page. This module
 * is loaded when the sheet is first opened (shell/create-post.tsx), never with the page: it
 * carries the dialog, the editor and the form, and fetches its own data.
 */
export default function ComposerSheetHost({ community, onClose }: { community?: string; onClose: () => void }) {
  const { t } = useTranslate();
  const router = useRouter();
  const [data, setData] = useState<ComposerData | 'loading' | 'failed'>('loading');

  useEffect(() => {
    let live = true;
    loadComposer({ data: community ? { community } : {} }).then(
      (loaded) => live && setData(loaded),
      () => live && setData('failed'),
    );
    return () => {
      live = false;
    };
  }, [community]);

  return (
    <ComposerSheet open onOpenChange={(open) => !open && onClose()} title={t('composer', 'title.create')}>
      {data === 'loading' && <p className="pb-muted">{t('composer', 'loading')}</p>}
      {data === 'failed' && (
        <p role="alert">
          {t('composer', 'loadFailed')} <a href="/submit">{t('composer', 'openPage')}</a>
        </p>
      )}
      {typeof data === 'object' && data.status === 'unavailable' && (
        <p role="alert">
          {t('composer', `unavailable.${data.reason}`)} <a href="/submit">{t('composer', 'openPage')}</a>
        </p>
      )}
      {typeof data === 'object' && data.status === 'ready' && (
        <Composer
          data={data}
          keepOnClose
          onDone={(path) => {
            onClose();
            openInRouter(router, path);
          }}
          onDiscard={onClose}
        />
      )}
    </ComposerSheet>
  );
}
