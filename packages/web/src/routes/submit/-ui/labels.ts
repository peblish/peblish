import type { MarkdownEditorLabels } from '@peblish/ui/composer/markdown-editor';
import { useTranslate } from '../../../i18n/use-translate.ts';

/** The strings the Markdown editor takes as props, in the request's locale. */
export function useEditorLabels(): MarkdownEditorLabels {
  const { t } = useTranslate();
  return {
    toolbar: t('composer', 'editor.toolbar'),
    bold: t('composer', 'editor.bold'),
    italic: t('composer', 'editor.italic'),
    strikethrough: t('composer', 'editor.strikethrough'),
    link: t('composer', 'editor.link'),
    quote: t('composer', 'editor.quote'),
    code: t('composer', 'editor.code'),
    bulletList: t('composer', 'editor.bulletList'),
    numberedList: t('composer', 'editor.numberedList'),
    heading: t('composer', 'editor.heading'),
    spoiler: t('composer', 'editor.spoiler'),
    linkText: t('composer', 'editor.linkText'),
    linkUrl: t('composer', 'editor.linkUrl'),
    view: t('composer', 'editor.view'),
    write: t('composer', 'editor.write'),
    preview: t('composer', 'editor.preview'),
    previewLoading: t('composer', 'editor.previewLoading'),
    previewEmpty: t('composer', 'editor.previewEmpty'),
    previewFailed: t('composer', 'editor.previewFailed'),
  };
}
