import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react';

/** The value props of a Mux text field root (Input.Root, TextArea.Root). */
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
 * field that mounts on the client already shows what React rendered, so nothing changes there.
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
    const control = root.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type="hidden"]), textarea');
    if (control && control.value !== first.current.shown) first.current.change(control.value);
  }, []);
  useImperativeHandle<E | null, E | null>(callerRef, () => root.current, []);
  return { value: shown, defaultValue, onChange: change, ref: root };
}
