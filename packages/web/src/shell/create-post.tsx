import { PlusIcon } from '@peblish/ui/components/icons';
import { useTranslate } from '../i18n/use-translate.ts';
import { createPostPath } from './paths.ts';

/**
 * The "Create post" entry in the top bar: a plain link to the composer page. Lane COMPOSER
 * takes this file over to open the composer as a sheet over the feed instead.
 */
export function CreatePost() {
  const { t } = useTranslate();
  return (
    <a className="pb-create" href={createPostPath}>
      <PlusIcon />
      <span>{t('shell', 'create')}</span>
    </a>
  );
}
