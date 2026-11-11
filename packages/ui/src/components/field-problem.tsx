import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type RefObject } from 'react';

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

/**
 * The browser's verdict on the control inside `ref`, in the page's language, with the stable id
 * its message is shown under. It follows React Aria's native validation: a blocked submit (the
 * `invalid` event) or a committed edit (`change`) shows the current verdict, a fixed value clears
 * it at the next commit, and a form reset clears it. React Aria focuses the first invalid control
 * and stops the browser's bubble for its own fields; a control it does not manage (`native`, the
 * native select) gets both done here, so a select in a form behaves like the fields around it.
 * A form with `noValidate` checks its own values, so its fields say nothing here. Nothing runs
 * before hydration or without JavaScript: the browser validates as it always does.
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
  errorId: string;
  recheck: () => void;
} {
  const labels = useContext(FieldLabelsContext);
  const ref = useRef<E>(null);
  const [problem, setProblem] = useState<string>();
  // Mux UI rc.6 links a late error part to its control only when the part has its id on mount.
  const errorId = useId();
  const native = options.native === true;
  const [asked, setAsked] = useState(0);

  const commit = useCallback(
    (control: EventTarget | null) => {
      if (isControl(control)) setProblem(control.form?.noValidate ? undefined : explainValidity(control, labels));
    },
    [labels],
  );

  useEffect(() => {
    if (asked === 0) return;
    const root = ref.current;
    commit(isControl(root) ? root : (root?.querySelector('input:not([type="hidden"]), textarea, select') ?? null));
  }, [asked, commit]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const judge = (event: Event) => commit(event.target);
    const blocked = (event: Event) => {
      judge(event);
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

  const recheck = useCallback(() => setAsked((count) => count + 1), []);
  return { ref, problem, errorId, recheck };
}

/**
 * The id to give a field's error part. An error there from the first render (a refusal the server
 * rendered) keeps React Aria's own id, which links it in the server's markup too; one that appears
 * later gets the stable `errorId`, since Mux UI rc.6 only links a late part that has an id on mount.
 */
export function useErrorPartId(shown: boolean, errorId: string): string | undefined {
  const [fromStart] = useState(shown);
  const [gone, setGone] = useState(false);
  if (fromStart && !shown && !gone) setGone(true);
  return shown && (!fromStart || gone) ? errorId : undefined;
}
