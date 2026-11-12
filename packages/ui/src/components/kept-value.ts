import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react';

/**
 * The property on a text area that holds what was typed into it before its field mounted, with
 * the selection at that moment (the script below writes it), or null once the field has taken it
 * over. Never an attribute, so hydration sees no difference, and never stored or sent anywhere.
 */
export const typedKey = '__pbTyped';

/**
 * The inline script in every page's head (`__root.tsx`). React DOM puts a text area's rendered
 * text back while it hydrates (when that text is not empty), so what a person typed into a text
 * area that already held text is gone before any component can read it. This records the text as
 * it is typed, on the element, for `useKeptValue` to adopt. Only text areas: an input keeps its
 * typed value (and its caret) through hydration, so a password never sits in a record. The caret
 * is recorded too: putting the text back moves a text area's caret to the end. A text area whose field
 * has mounted (hydrated, or rendered on the client) has the record set to null and is skipped, so
 * a part of the page that hydrates later is still covered and a mounted one is never recorded.
 */
export const typedTextScript = `document.addEventListener('input',function(e){var t=e.target;if(t instanceof HTMLTextAreaElement&&t.${typedKey}!==null)t.${typedKey}=[t.value,t.selectionStart,t.selectionEnd,t.selectionDirection]},true)`;

/** What the script records: the text, and the selection's start, end and direction. */
type Recorded = [text: string, start: number, end: number, direction: 'forward' | 'backward' | 'none'];

type Control = (HTMLInputElement | HTMLTextAreaElement) & { [K in typeof typedKey]?: Recorded | null };

/** The value props of a Mux text field root (Input.Root, TextArea.Root, SearchField). */
export interface ValueProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}

/**
 * Keeps the text a person typed into a server-rendered field before the page hydrated.
 *
 * React Aria holds a text field's value in its own state and renders the control as controlled,
 * starting from the server's value; keystrokes made before its scripts ran never reach that state.
 * React leaves the typed text in place while it hydrates, but the field renders again straight
 * after (React Aria's TextField as soon as the text area's ref attaches, Mux's Input when its
 * description registers, any field on its next focus change), and that render writes the old value
 * over the text: the form then posts an empty field. So the root reads its control once, as it
 * mounts: text that differs from the value React rendered was typed (or restored by the browser)
 * before hydration, and becomes the field's value, through `onChange` for a controlled field. A
 * text area's record from `typedTextScript` wins over its current value, which React may already
 * have put back. A field that mounts on the client already shows what React rendered, so nothing
 * changes there, and with nothing typed no `onChange` fires. The field then marks its control as
 * taken over, so a second run of the check (Strict Mode) does nothing.
 *
 * Returns the props for the Mux root: always a controlled `value`, the `onChange` that keeps it,
 * and a `ref` for its element, which the caller's ref also receives (before the caller's own
 * layout effects run).
 */
export function useKeptValue<E extends HTMLElement>(
  { value, defaultValue, onChange }: ValueProps,
  callerRef: Ref<E> | undefined,
): { value: string; defaultValue: string | undefined; onChange: (next: string) => void; ref: RefObject<E | null> } {
  const [own, setOwn] = useState(defaultValue ?? '');
  const controlled = value !== undefined;
  const shown = controlled ? value : own;
  const change = (next: string) => {
    if (!controlled) setOwn(next);
    onChange?.(next);
  };
  const root = useRef<E | null>(null);
  // What the first commit rendered and how to change it, for the mount-only check below.
  const first = useRef({ shown, change });
  // The selection recorded with text it adopted, until the text is in the control (below).
  const caret = useRef<Recorded | null>(null);
  useLayoutEffect(() => {
    const control: Control | null | undefined = root.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type="hidden"]), textarea',
    );
    if (!control || control[typedKey] === null) return;
    const recorded = control[typedKey];
    const text = recorded?.[0] ?? control.value;
    control[typedKey] = null;
    if (text === first.current.shown) return;
    caret.current = recorded ?? null;
    first.current.change(text);
  }, []);
  // The render after that one writes the adopted text into the text area, which moves its caret to
  // the end: put the recorded selection back, if the person is still in that field and it holds
  // what they typed. Once the text has changed from what was first rendered, it is settled either way.
  useLayoutEffect(() => {
    const recorded = caret.current;
    const control = root.current?.querySelector('textarea');
    if (!recorded || !control || shown === first.current.shown) return;
    caret.current = null;
    if (control.value === recorded[0] && control.ownerDocument.activeElement === control)
      control.setSelectionRange(recorded[1], recorded[2], recorded[3]);
  }, [shown]);
  useImperativeHandle<E | null, E | null>(callerRef, () => root.current, []);
  return { value: shown, defaultValue, onChange: change, ref: root };
}
