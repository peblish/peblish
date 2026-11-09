import { useTranslate } from '../../../i18n/use-translate.ts';
import { errorMessageKey, type ComposerError } from '../-types.ts';

/** The message for a composer error code (the media refusals have theirs in the media catalogue). */
export function ErrorText({ code }: { code: ComposerError }) {
  const { t } = useTranslate();
  const message = errorMessageKey(code);
  return message.area === 'media' ? t('media', message.key) : t('composer', message.key);
}
