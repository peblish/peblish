import { Button } from '@peblish/ui/components/button';
import { Popover } from '@peblish/ui/components/popover';
import { ToggleButton, ToggleButtonGroup } from '@peblish/ui/components/toggle-button-group';
import { schemes, toScheme, type Scheme } from '@peblish/ui/theme/root';
import { useTranslate } from '../i18n/use-translate.ts';
import { usePrefs } from './prefs.tsx';

const isScheme = (id: string | undefined): id is Scheme => schemes.some((scheme) => scheme === id);

/**
 * The three choices. Mux UI's Popover is an inverse surface whose contents keep the page's
 * scheme, so they sit in the opposite scheme to read on it. This only renders once the popover
 * opens, in the browser, so it may ask the OS for 'system'.
 */
function Choices({ label }: { label: string }) {
  const { t } = useTranslate();
  const { prefs, setPrefs } = usePrefs();
  const scheme = toScheme(prefs.scheme);
  const dark = scheme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : scheme === 'dark';
  return (
    <div data-muxui-color-scheme={dark ? 'light' : 'dark'}>
      <ToggleButtonGroup
        aria-label={label}
        selectionMode="single"
        disallowEmptySelection
        size="sm"
        selectedIds={[scheme]}
        onSelectionChange={([id]) => isScheme(id) && setPrefs({ scheme: id })}
      >
        {schemes.map((choice) => (
          <ToggleButton key={choice} id={choice}>
            {t('shell', `theme.${choice}`)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
  );
}

/**
 * Light, dark or the system's choice, stored in the display cookie. Mux UI's ColorModeToggle
 * does not fit (two schemes, local storage), so this is a ToggleButtonGroup in a Popover. Both
 * need scripts; without them the stored scheme still renders, it just cannot be changed here.
 */
export function ThemeMenu() {
  const { t } = useTranslate();
  const label = t('shell', 'theme.menu');
  return (
    <Popover
      aria-label={label}
      placement="bottom-end"
      trigger={
        <Button variant="ghost" size="sm">
          {label}
        </Button>
      }
    >
      <Choices label={label} />
    </Popover>
  );
}
