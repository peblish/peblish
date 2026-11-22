import { ComboBox } from '@muxui/react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useHydrated } from '../composer/use-hydrated.ts';
import { FieldAlert } from './field-problem.tsx';
import { BidiText, Handle, neutraliseBidi } from './handle.tsx';
import { Text } from './text.tsx';

/** A community the field offers. */
export interface CommunityOption {
  id: string;
  /** Its display name, if it has one. */
  displayName: string | null;
  /** `name`, or `name@host` for one on another server. */
  handle: string;
  /** What else to know, after the handle: where it lives, its members, why it is closed to the viewer. */
  description?: string;
  /** The viewer may not post there: shown, not chosen. */
  disabled?: boolean;
}

/** A named group of options; a group with nothing that matches the text is hidden. */
export interface CommunityGroup {
  id: string;
  title: string;
  options: readonly CommunityOption[];
}

export interface CommunityFieldLabels {
  label: string;
  placeholder: string;
  /** The last group's title, over the row that leads to the directory. */
  elsewhere: string;
  browse: string;
  /** Said over Browse when nothing matches. */
  none: string;
}

export interface CommunityFieldProps {
  /** The form field's name: the chosen option's id is posted under it. */
  name: string;
  groups: readonly CommunityGroup[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** The last row: the whole directory (the caller keeps what was typed in the form). */
  onBrowse: () => void;
  labels: CommunityFieldLabels;
  description?: ReactNode;
  /** Shown while set; the field is then invalid. */
  error?: ReactNode;
  required?: boolean;
  /**
   * The choice as plain radios under `name`: the form control until the page hydrates (for good without scripts).
   * Then the field takes their place, and the radio chosen on the server's page becomes its choice (`onChange`).
   */
  fallback: ReactNode;
}

const browseId = 'pb-community-field-browse';

/** What a row is found and shown by once chosen: its name, and its handle, which tells two of one name apart. */
export const optionText = ({ displayName, handle }: Pick<CommunityOption, 'displayName' | 'handle'>) =>
  neutraliseBidi(displayName ? `${displayName} (!${handle})` : `!${handle}`, '');

/** Lowercase, accents, spaces and a leading "!" dropped: "HOME bak ing" finds "Home Baking". */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^!/, '');
const matches = (text: string, input: string) => fold(text).includes(fold(input));

/**
 * Create post's community (Commons): Mux ComboBox with named groups, the viewer's joined communities first, then
 * the rest they may post in, then a row to the directory. Typing narrows the rows by name or handle (with or without
 * "!" and the host); the arrows run through every group, Enter takes the highlighted row, or the first row shown when
 * none is highlighted; Escape closes the list and keeps the choice; Tab moves on and chooses nothing. Emptying the
 * text clears the choice. Browse shows when the text is empty or matches nothing, and says so then.
 *
 * Until the page hydrates, and without scripts, `fallback` is the form control in its place.
 */
export function CommunityField({
  name,
  groups,
  value,
  onChange,
  onBrowse,
  labels,
  description,
  error,
  required,
  fallback,
}: CommunityFieldProps) {
  const hydrated = useHydrated();
  const radios = useRef<HTMLDivElement>(null);
  // As the page hydrates, a radio checked on the server's page (React keeps it checked and tells no one) becomes the
  // field's choice, and so does one checked in the moment before the field takes their place.
  useEffect(() => {
    const list = radios.current;
    if (!list) return;
    const picked = () => list.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value;
    const first = picked();
    if (first && first !== value) onChange(first);
    const report = () => {
      const next = picked();
      if (next) onChange(next);
    };
    list.addEventListener('change', report);
    return () => list.removeEventListener('change', report);
    // Once, as it hydrates: mounted on a page already running (the sheet, a client navigation) it has no radios.
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);
  const options = groups.flatMap((group) => group.options);
  const chosen = options.find((option) => option.id === value);
  // What the person typed, or null for the choice's own name, so a choice the form makes itself (a community that is
  // gone, the radio chosen before hydration) shows in the field.
  const [typed, setTyped] = useState<string | null>(null);
  const chosenText = chosen ? optionText(chosen) : '';
  const text = typed ?? chosenText;
  const anyMatch = (input: string) => options.some((option) => matches(optionText(option), input));
  const sections = [
    ...groups.map((group) => ({
      id: group.id,
      title: group.title,
      items: group.options.map((option) => ({
        id: option.id,
        textValue: optionText(option),
        disabled: option.disabled,
        label: (
          // The row's name and its description, as React Aria's slots: an unslotted Text would be taken as the name.
          <span className="pb-cfield__option">
            <Text slot="label" variant="label" size="sm" className="pb-cfield__title">
              {option.displayName ? <BidiText text={option.displayName} /> : <Handle prefix="!" handle={option.handle} />}
            </Text>
            <Text slot="description" size="sm" color="muted" className="pb-cfield__meta">
              {option.displayName && <Handle prefix="!" handle={option.handle} />}
              {option.displayName && option.description ? `, ${option.description}` : option.description}
            </Text>
          </span>
        ),
      })),
    })),
    {
      id: 'pb-community-field-elsewhere',
      title: labels.elsewhere,
      items: [
        {
          id: browseId,
          textValue: labels.browse,
          label: (
            <span className="pb-cfield__option">
              {text.trim() && !anyMatch(text) && (
                <Text slot="description" size="sm" color="muted" className="pb-cfield__none">
                  {labels.none}
                </Text>
              )}
              <Text slot="label" size="sm" className="pb-cfield__browse">
                {labels.browse}
              </Text>
            </span>
          ),
        },
      ],
    },
  ];
  // Browse matches nothing typed: it shows on an empty text, and when no community matches.
  const filter = (rowText: string, input: string) =>
    rowText === labels.browse ? !input.trim() || !anyMatch(input) : !input.trim() || matches(rowText, input);
  // Enter with no row highlighted takes the first community shown, as a press on it would (React Aria highlights a
  // row only once an arrow reaches one, so Enter alone did nothing). Caught before React Aria sees it.
  const onEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    const input = event.target;
    if (event.key !== 'Enter' || !text.trim() || !(input instanceof HTMLInputElement)) return;
    if (input.getAttribute('aria-expanded') !== 'true' || input.getAttribute('aria-activedescendant')) return;
    event.preventDefault();
    event.stopPropagation();
    const first = options.find((option) => !option.disabled && matches(optionText(option), text));
    if (!first) return onBrowse();
    onChange(first.id);
    setTyped(null);
  };
  if (!hydrated) {
    return (
      <div className="pb-cfield" ref={radios}>
        {fallback}
      </div>
    );
  }
  return (
    <div className="pb-cfield" onKeyDownCapture={onEnter}>
      <ComboBox
        className="pb-cfield__combo"
        label={labels.label}
        placeholder={labels.placeholder}
        name={name}
        required={required}
        invalid={error !== undefined}
        // React Aria's error part drops a role, so the alert is the span inside it.
        errorMessage={error === undefined ? undefined : <FieldAlert>{error}</FieldAlert>}
        description={description}
        sections={sections}
        value={text}
        selectedId={value}
        // React Aria puts the chosen row's name back itself (on Escape, on leaving): that is no typing.
        onChange={(next) => setTyped(next === chosenText ? null : next)}
        onSelect={(item) => {
          if (!item) return onChange(null);
          if (item.id === browseId) return onBrowse();
          const option = options.find(({ id }) => id === item.id);
          if (!option) return;
          onChange(option.id);
          setTyped(null);
        }}
        // React Aria's own props, which Mux passes through: the whole list on focus, and the filter above.
        {...{ menuTrigger: 'focus', defaultFilter: filter }}
      />
    </div>
  );
}
