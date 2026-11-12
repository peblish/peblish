import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react';

/**
 * The property on a text area that holds what was typed into it before its field mounted (the
 * script below writes it), or null once the field has taken it over. Never an attribute, so
 * hydration sees no difference, and never stored or sent anywhere.
 */
export const typedKey = '__pbTyped';

/**
 * The inline script in every page's head (`__root.tsx`). React DOM puts a text area's rendered
 * text back while it hydrates (when that text is not empty), so what a person typed into a text
 * area that already held text is gone before any component can read it. This records the text as
 * it is typed, on the element, for `useKeptValue` to adopt. Only text areas: an input keeps its
 * typed value through hydration, so a password never sits in a record. A text area whose field
 * has mounted (hydrated, or rendered on the client) has the record set to null and is skipped, so
 * a part of the page that hydrates later is still covered and a mounted one is never recorded.
 */
export const typedTextScript = `document.addEventListener('input',function(e){var t=e.target;if(t instanceof HTMLTextAreaElement&&t.${typedKey}!==null)t.${typedKey}=t.value},true)`;

type Control = (HTMLInputElement | HTMLTextAreaElement) & { [K in typeof typedKey]?: string | null };

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
  useLayoutEffect(() => {
    const control: Control | null | undefined = root.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type="hidden"]), textarea',
    );
    if (!control || control[typedKey] === null) return;
    const text = control[typedKey] ?? control.value;
    control[typedKey] = null;
    if (text !== first.current.shown) first.current.change(text);
  }, []);
  useImperativeHandle<E | null, E | null>(callerRef, () => root.current, []);
  return { value: shown, defaultValue, onChange: change, ref: root };
}
