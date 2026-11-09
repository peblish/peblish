import { schemes, type Scheme } from '@peblish/ui/theme/root';
import { useTranslate } from '../i18n/use-translate.ts';
import { usePrefs } from './prefs.tsx';

/** Light, dark, true black or the system's choice, stored in the display cookie. */
export function ThemeMenu() {
  const { t } = useTranslate();
  const { prefs, setPrefs } = usePrefs();
  return (
    <details className="pb-menu pb-theme">
      <summary aria-label={t('shell', 'theme.menu')}>{t('shell', 'theme.menu')}</summary>
      <div className="pb-menu__panel" role="group" aria-label={t('shell', 'theme.menu')}>
        {schemes.map((scheme: Scheme) => (
          <button key={scheme} type="button" aria-pressed={prefs.scheme === scheme} onClick={() => setPrefs({ scheme })}>
            {t('shell', `theme.${scheme}`)}
          </button>
        ))}
      </div>
    </details>
  );
}
