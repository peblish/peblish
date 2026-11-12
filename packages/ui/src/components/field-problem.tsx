import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/**
 * What a field says when the browser finds its value invalid and the caller gave no message of
 * its own. `{min}` and `{max}` are filled in with the field's limit, formatted for `locale`. The
 * web app provides these in the request's language (FieldLabelsProvider, from the `ui` catalogue).
 */
export interface FieldLabels {
  locale: string;
  required: string;
  /** A required checkbox left unticked. */
  requiredCheck: string;
  /** A required select with nothing chosen. */
  requiredChoice: string;
  email: string;
  url: string;
  tooShort: string;
  tooLong: string;
  pattern: string;
  rangeUnderflow: string;
  rangeOverflow: string;
  invalid: string;
}

/** The English messages, for a field rendered without the web app's provider (tests, the kit). */
export const englishFieldLabels: FieldLabels = {
  locale: 'en',
  required: 'Fill in this field.',
  requiredCheck: 'Tick this box to continue.',
  requiredChoice: 'Choose an option.',
  email: 'Enter an email address, like name@example.com.',
  url: 'Enter a full link, like https://example.com.',
  tooShort: 'Use at least {min} characters.',
  tooLong: 'Use at most {max} characters.',
  pattern: 'Use the format shown.',
  rangeUnderflow: 'Enter {min} or more.',
  rangeOverflow: 'Enter {max} or less.',
  invalid: 'Check what you entered here.',
};
const FieldLabelsContext = createContext<FieldLabels>(englishFieldLabels);
export const FieldLabelsProvider = FieldLabelsContext.Provider;

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const isControl = (target: EventTarget | null): target is Control =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

/** What `explainValidity` reads of a control: an input, text area or select fits it as it is. */
export interface JudgedControl {
  type: string;
  validity: Pick<
    ValidityState,
    | 'valueMissing'
    | 'typeMismatch'
    | 'tooShort'
    | 'tooLong'
    | 'patternMismatch'
    | 'rangeUnderflow'
    | 'rangeOverflow'
    | 'badInput'
    | 'stepMismatch'
  >;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
}

/**
 * The message for a control's current validity, or undefined when the browser's own constraints
 * pass. A custom error alone does not count: React Aria sets one itself while a field is marked
 * invalid, and whoever marked it explains it.
 */
export function explainValidity(control: JudgedControl, labels: FieldLabels): string | undefined {
  const { validity, type } = control;
  const fill = (message: string, limit: string | number | undefined) =>
    message.replace(/\{(min|max)\}/g, () => {
      const number = Number(limit);
      return limit !== undefined && limit !== '' && Number.isFinite(number)
        ? new Intl.NumberFormat(labels.locale).format(number)
        : String(limit ?? '');
    });
  if (validity.valueMissing) {
    if (type.startsWith('select')) return labels.requiredChoice;
    if (type === 'checkbox' || type === 'radio') return labels.requiredCheck;
    return labels.required;
  }
  if (validity.typeMismatch && type === 'email') return labels.email;
  if (validity.typeMismatch && type === 'url') return labels.url;
  if (validity.tooShort) return fill(labels.tooShort, control.minLength);
  if (validity.tooLong) return fill(labels.tooLong, control.maxLength);
  if (validity.patternMismatch) return labels.pattern;
  if (validity.rangeUnderflow) return fill(labels.rangeUnderflow, control.min);
  if (validity.rangeOverflow) return fill(labels.rangeOverflow, control.max);
  if (validity.typeMismatch || validity.badInput || validity.stepMismatch) return labels.invalid;
  return undefined;
}

/** What happens to a field: a blocked submit, a committed edit, a keystroke, a form reset. */
export type FieldEvent = 'invalid' | 'change' | 'input' | 'reset';

/**
 * The message a field shows after `event`, given the one it shows now and the browser's verdict
 * on its value now. A blocked submit or a committed edit shows the verdict (React Aria's timing).
 * A keystroke only ever takes a message away, once the value is valid: a field nobody has found
 * wrong yet says nothing while it is typed in, and a correction clears its message while the
 * person is still typing. Were it cleared at the commit, which for text is leaving the field, the
 * press on the submit button below would commit it: the button would move up by the message's
 * height between the press and the release, and the release would miss it, losing the click.
 */
export function nextProblem(event: FieldEvent, shown: string | undefined, verdict: string | undefined): string | undefined {
  if (event === 'reset') return undefined;
  if (event === 'input') return verdict === undefined ? undefined : shown;
  return verdict;
}

/** The control a field root holds (or the root itself, for the native select). */
const controlOf = (root: HTMLElement | null) =>
  isControl(root) ? root : (root?.querySelector('input:not([type="hidden"]), textarea, select') ?? null);

/**
 * The browser's verdict on the control inside `ref`, in the page's language, shown at the moments
 * `nextProblem` names: a blocked submit (the `invalid` event) or a committed edit (`change`) shows
 * it, a keystroke that makes the value valid clears it (`settle`), and a form reset clears it.
 * React Aria focuses the first invalid control and stops the browser's bubble for its own fields;
 * a control it does not manage (`native`, the native select) gets both done here, so a select in a
 * form behaves like the fields around it. A form with `noValidate` checks its own values, so its
 * fields say nothing here. Nothing runs before hydration or without JavaScript: the browser
 * validates as it always does.
 *
 * `settle` is for the field's `onChange` on each keystroke. It runs inside React's handling of the
 * input event, so the field re-renders with its new value: a native listener here would re-render
 * it first, and React would write the old value of a controlled field back. A native select needs
 * none, since its `change` comes with the choice.
 *
 * `recheck` commits a change that fires no native `change` event: Mux UI's checkbox toggles on a
 * React Aria press, so its wrapper calls it from `onChange`, and the verdict is read once React
 * has written the new state to the input.
 */
export function useFieldProblem<E extends HTMLElement>(
  options: { native?: boolean } = {},
): {
  ref: RefObject<E | null>;
  problem: string | undefined;
  settle: () => void;
  recheck: () => void;
} {
  const labels = useContext(FieldLabelsContext);
  const ref = useRef<E>(null);
  const [problem, setProblem] = useState<string>();
  const native = options.native === true;
  const [asked, setAsked] = useState(0);

  /** The verdict on `control` now, or none in a form that checks its own values. */
  const verdictOf = useCallback((control: Control) => (control.form?.noValidate ? undefined : explainValidity(control, labels)), [labels]);
  // A blocked submit or a committed edit (nextProblem's `invalid` and `change`) shows the verdict.
  const commit = useCallback(
    (control: EventTarget | null) => {
      if (isControl(control)) setProblem(verdictOf(control));
    },
    [verdictOf],
  );

  useEffect(() => {
    if (asked === 0) return;
    commit(controlOf(ref.current));
  }, [asked, commit]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const judge = (event: Event) => commit(event.target);
    const blocked = (event: Event) => {
      commit(event.target);
      const control = event.target;
      if (!native || !isControl(control)) return;
      const first = control.form && Array.from(control.form.elements).find((element) => isControl(element) && !element.validity.valid);
      if (!event.defaultPrevented && first === control) control.focus();
      event.preventDefault();
    };
    const reset = () => setProblem(undefined);
    const form = root.closest('form');
    // `invalid` does not bubble, so the root listens in the capture phase; it runs before React Aria's own listener.
    root.addEventListener('invalid', blocked, true);
    root.addEventListener('change', judge, true);
    form?.addEventListener('reset', reset);
    return () => {
      root.removeEventListener('invalid', blocked, true);
      root.removeEventListener('change', judge, true);
      form?.removeEventListener('reset', reset);
    };
  }, [native, commit]);

  // The browser has the typed value already, so its validity can be read at once.
  const settle = useCallback(() => {
    const control = controlOf(ref.current);
    if (problem !== undefined && isControl(control)) setProblem(nextProblem('input', problem, verdictOf(control)));
  }, [problem, verdictOf]);
  const recheck = useCallback(() => setAsked((count) => count + 1), []);
  return { ref, problem, settle, recheck };
}

/**
 * The words of a field's error, announced when they appear, for the two Mux error parts that still
 * drop a `role` prop in rc.7: SelectNative's and RadioGroup's (React Aria's FieldError). Every other
 * Mux error part (Input, TextArea, CheckboxField) takes `role="alert"` itself.
 */
export function FieldAlert({ children }: { children: ReactNode }) {
  return <span role="alert">{children}</span>;
}
