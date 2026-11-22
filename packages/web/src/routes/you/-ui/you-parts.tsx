import { Avatar } from '@peblish/ui/components/avatar';
import { avatarInitial } from '@peblish/ui/components/avatar-initial.ts';
import { Handle } from '@peblish/ui/components/handle';
import type { IconProps } from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { ToggleButton, ToggleButtonGroup } from '@peblish/ui/components/toggle-button-group';
import { schemes, type Scheme } from '@peblish/ui/theme/root';
import { useId, type ComponentType, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';

/** One row of the You page: a page of the account or the site, with its glyph. */
export type YouLink = { href: string; label: string; icon: ComponentType<IconProps> };

/** The viewer's avatar (its initial), name and handle at the top of the You page. */
export function YouIdentity({ name, handle }: { name: string; handle: string }) {
  return (
    <div className="you-id">
      {/* Decorative: the heading names the person. */}
      <Avatar.Root size="lg" aria-hidden="true">
        <Avatar.Fallback>{avatarInitial(name, '')}</Avatar.Fallback>
      </Avatar.Root>
      <div className="you-id__text">
        <Text as="h1" variant="title" size="sm" className="you-id__name">
          {name}
        </Text>
        <Text as="p" variant="mono" size="sm" color="muted" className="you-id__handle">
          <Handle prefix="@" handle={handle} />
        </Text>
      </div>
    </div>
  );
}

/** A titled part of the You page under its h2; `nav` makes it a navigation landmark the heading names. */
function Part({ title, nav = false, className, children }: { title: string; nav?: boolean; className?: string; children: ReactNode }) {
  const id = useId();
  const Tag = nav ? 'nav' : 'div';
  return (
    <Tag className={['you-part', className].filter(Boolean).join(' ')} aria-labelledby={nav ? id : undefined}>
      <Text as="h2" id={id} variant="label" size="sm" color="muted" className="you-part__title">
        {title}
      </Text>
      {children}
    </Tag>
  );
}

/**
 * A list of pages as rows of plain links (Commons' You tab): each a 44px target with its glyph, so the
 * list works with scripts off. A navigation named by its heading.
 */
export function YouLinks({ title, links }: { title: string; links: readonly YouLink[] }) {
  return (
    <Part title={title} nav>
      <ul className="you-links">
        {links.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link className="you-link pb-link-quiet" href={href}>
              <Icon className="you-link__icon" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </Part>
  );
}

/**
 * Appearance on the You page: System, Light or Dark as one Mux ToggleButtonGroup in the page itself, where
 * the header's account menu holds it on a computer. Controlled, so the gallery can show it without changing
 * its own scheme. It needs scripts: the page passes `disabled` until hydration, and with scripts off
 * the part is not shown (you.css).
 */
export function AppearanceChoice({
  value,
  onChange,
  disabled = false,
}: {
  value: Scheme;
  onChange: (scheme: Scheme) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslate();
  const label = t('shell', 'theme.menu');
  return (
    <Part title={label} className="you-appearance">
      <ToggleButtonGroup
        aria-label={label}
        selectionMode="single"
        disallowEmptySelection
        disabled={disabled}
        selectedIds={[value]}
        onSelectionChange={([id]) => {
          const scheme = schemes.find((choice) => choice === id);
          if (scheme) onChange(scheme);
        }}
      >
        {schemes.map((choice) => (
          <ToggleButton key={choice} id={choice}>
            {t('shell', `theme.${choice}`)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Part>
  );
}
