import { ComboBox } from '@muxui/react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
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
   * The choice as a plain form control, for a browser without scripts: rendered in `<noscript>`, so it is real
   * only there (with scripts it is inert text, and the field above, hidden without scripts, posts the choice).
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
 * Until the page hydrates the field is disabled and a hidden input posts the server's choice; without scripts the
 * field is hidden and `fallback` is the form control.
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
  const options = groups.flatMap((group) => group.options);
  const chosen = options.find((option) => option.id === value);
  const [text, setText] = useState(chosen ? optionText(chosen) : '');
  // A choice the form makes itself (a community that is gone, a draft's) puts its name in the field.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(chosen ? optionText(chosen) : '');
  }
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
    setText(optionText(first));
  };
  return (
    <div className="pb-cfield" onKeyDownCapture={onEnter}>
      <ComboBox
        className="pb-cfield__combo"
        label={labels.label}
        placeholder={labels.placeholder}
        // Posted only once hydrated: before then a submit has no choice to send, and without scripts the fallback posts it.
        name={hydrated ? name : undefined}
        disabled={!hydrated}
        required={required}
        invalid={error !== undefined}
        // React Aria's error part drops a role, so the alert is the span inside it.
        errorMessage={error === undefined ? undefined : <FieldAlert>{error}</FieldAlert>}
        description={description}
        sections={sections}
        value={text}
        selectedId={value}
        onChange={setText}
        onSelect={(item) => {
          if (!item) return onChange(null);
          if (item.id === browseId) return onBrowse();
          const option = options.find(({ id }) => id === item.id);
          if (!option) return;
          onChange(option.id);
          setText(optionText(option));
        }}
        // React Aria's own props, which Mux passes through: the whole list on focus, and the filter above.
        {...{ menuTrigger: 'focus', defaultFilter: filter }}
      />
      <noscript>{fallback}</noscript>
      {/* Until hydration (scripts on) the noscript list is inert text and the field posts nothing: this posts the
          server's choice, so a plain post before hydration still names it. Without scripts it follows the radios, and
          a form's first value of a name wins on the server (routes/submit/-submit.ts), so a radio's choice does. */}
      {!hydrated && value !== null && <input type="hidden" name={name} value={value} />}
    </div>
  );
}
