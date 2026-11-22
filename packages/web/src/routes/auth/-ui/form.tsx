import { Input } from '@peblish/ui/components/input';
import { Notice } from '@peblish/ui/components/notice';
import { type } from 'arktype';
import { Link } from '@peblish/ui/components/link';
import {
  createContext,
  Fragment,
  use,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asFormError, errorKey, type FormError } from './errors.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

/**
 * The field a refusal is about, by the names a form's fields may have (the first one the form has
 * wins): sign-up's and reset's `password`, the security page's `current` and `next`. A refusal that
 * names no field (wrong credentials, a rate limit) stays the form's alone.
 */
const fieldOfError: Partial<Record<FormError, readonly string[]>> = {
  'invite.unknown': ['invite'],
  'invite.expired': ['invite'],
  'invite.exhausted': ['invite'],
  'invite.revoked': ['invite'],
  'name.invalid': ['username'],
  'name.reserved': ['username'],
  'name.taken': ['username'],
  'email.invalid': ['email'],
  'email.taken': ['email'],
  'password.too_short': ['password', 'next'],
  'password.too_long': ['password', 'next'],
  'password.wrong': ['password', 'current'],
  'two_factor.invalid_code': ['code'],
  'confirm.mismatch': ['confirm'],
};

/**
 * The refusal a form is showing, for its fields: the field it is about (by `fieldOfError`, never two in
 * one form) says it too, and takes `id`, the summary's link target.
 */
const RefusalContext = createContext<{ error: FormError; id: string; answer: number } | undefined>(undefined);

/**
 * A form that posts to its route and works without JavaScript (the server answers 303).
 * Once hydrated it posts by fetch instead (Accept: application/json), so an error keeps
 * what was typed, and follows the redirect the server names with a full navigation, since
 * these forms change who is signed in. The error shows first, as a danger Notice: the form's
 * summary, which links to the field the refusal is about when there is one (`fieldOfError`).
 */
export function AuthForm({
  action,
  label,
  error: initial,
  className,
  children,
}: {
  action: string;
  label: string;
  error?: FormError | undefined;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslate();
  const [error, setError] = useState(initial);
  const [busy, setBusy] = useState(false);
  // Set from the press until the answer is in (a redirect keeps it while the page goes), so a second press,
  // or Enter in a field, posts nothing meanwhile: a recovery code is not spent twice. A ref, not the state,
  // so two presses before a render are refused too.
  const sending = useRef(false);
  // A page Back brings out of the browser's cache after a redirect is the same page, still locked: free it.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sending.current = false;
      setBusy(false);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  // Counts the answers, so a field that was typed in since one shows the next one's refusal again.
  const [answer, setAnswer] = useState(0);
  const refusedId = `${useId()}-refused`;
  const tied = error !== undefined && fieldOfError[error] !== undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget, submitter)) if (typeof value === 'string') body.append(name, value);
    setBusy(true);
    setAnswer((count) => count + 1);
    let leaving = false;
    try {
      const response = await fetch(action, { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return setError('generic');
      if (answer.redirect) {
        window.location.assign(answer.redirect);
        // Held only once the page is on its way: an address assign throws on frees the form, as a refusal does.
        leaving = true;
        return;
      }
      setError(asFormError(answer.error) ?? 'generic');
    } catch {
      setError('network');
    } finally {
      if (!leaving) {
        setBusy(false);
        sending.current = false;
      }
    }
  }

  return (
    <form method="post" action={action} aria-label={label} aria-busy={busy} className={className} onSubmit={submit}>
      {/* The summary: the refusal, as a link to the field it is about, which says it again (Field). */}
      {error && (
        <Notice tone="danger" role="alert">
          {tied ? <Link href={`#${refusedId}`}>{t('auth', errorKey(error))}</Link> : t('auth', errorKey(error))}
        </Notice>
      )}
      <RefusalContext value={error && { error, id: refusedId, answer }}>{children}</RefusalContext>
    </form>
  );
}

/**
 * A labelled Mux text field with an optional hint underneath (its description, linked for screen
 * readers) and an optional `aside` beside the label, such as a "Forgot?" link. The other props
 * are the input's own attributes; the value props and the flags go to the field root, which
 * controls the input.
 *
 * Once hydrated, React Aria stops the browser's own validation bubble, so a field the browser
 * finds invalid on submit explains itself here, in the page's language (the browser's message
 * follows the browser's language, not the page's), and is marked invalid while it says so. The
 * message and the flag go as soon as a keystroke makes the value valid, not at the blur: the press
 * on the submit button below is what blurs the field, and a message going then moves the button
 * between the press and the release, losing the click (the shared fields do the same,
 * `nextProblem` in @peblish/ui field-problem). A blur re-judges a message still showing. Without JavaScript the browser validates as it always does.
 *
 * A refusal from the server about this field (the form's alert, `AuthForm`) is said here too, under the
 * field and as its description, until the field is typed in; it is not a second alert.
 */
export function Field({
  label,
  hint,
  aside,
  value,
  defaultValue,
  required,
  disabled,
  readOnly,
  ...input
}: { label: string; hint?: ReactNode; aside?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useTranslate();
  const [problem, setProblem] = useState<string>();
  const refusal = use(RefusalContext);
  const refused = refusal && typeof input.name === 'string' && fieldOfError[refusal.error]?.includes(input.name) ? refusal : undefined;
  // The answer whose refusal this field was typed in after: it shows no more until the next answer.
  const [typedAfter, setTypedAfter] = useState<number>();
  const refusedMessage = refused && typedAfter !== refused.answer ? t('auth', errorKey(refused.error)) : undefined;
  const text = (given: typeof value) => (given === undefined ? undefined : String(given));
  // The message for the input's own constraints. A custom error is left out: React Aria sets one
  // itself while the field is marked invalid (below), so it would keep a corrected field wrong.
  const explain = (field: HTMLInputElement) => {
    const { validity } = field;
    if (validity.valueMissing) return t('auth', 'field.required');
    if (validity.typeMismatch && field.type === 'email') return t('auth', 'field.email');
    if (validity.tooShort) return t('auth', 'field.tooShort', { min: field.minLength });
    if (validity.tooLong) return t('auth', 'field.tooLong', { max: field.maxLength });
    const other = validity.typeMismatch || validity.patternMismatch || validity.rangeUnderflow || validity.rangeOverflow;
    return other || validity.badInput || validity.stepMismatch ? t('auth', 'field.invalid') : undefined;
  };
  return (
    <Input.Root
      className="auth-field"
      // The form's alert links here.
      id={refused ? refused.id : input.id}
      value={text(value)}
      defaultValue={text(defaultValue)}
      required={required}
      // The message and the invalid flag come from the same state, so they go together.
      invalid={problem !== undefined || refusedMessage !== undefined}
      disabled={disabled}
      readOnly={readOnly}
    >
      <div className="auth-field__head">
        <Input.Label>{label}</Input.Label>
        {aside}
      </div>
      <Input.Input
        {...input}
        onInvalid={(event: FormEvent<HTMLInputElement>) => {
          input.onInvalid?.(event);
          setProblem(explain(event.currentTarget));
        }}
        onInput={(event) => {
          input.onInput?.(event);
          if (refused) setTypedAfter(refused.answer);
          if (problem !== undefined && explain(event.currentTarget) === undefined) setProblem(undefined);
        }}
        onBlur={(event: FocusEvent<HTMLInputElement>) => {
          input.onBlur?.(event);
          if (problem !== undefined) setProblem(explain(event.currentTarget));
        }}
      />
      {hint && <Input.Description>{hint}</Input.Description>}
      {problem !== undefined ? (
        <Input.Error role="alert">{problem}</Input.Error>
      ) : (
        refusedMessage !== undefined && <Input.Error>{refusedMessage}</Input.Error>
      )}
    </Input.Root>
  );
}

/** A value the form posts that nobody sees or edits (an intent, a token, where to go next). */
export function Hidden({ name, value }: { name: string; value: string }) {
  return <Input.Input type="hidden" name={name} value={value} />;
}

/** A translated message whose {placeholders} are elements: links, emphasis. */
export function rich(message: string, parts: Record<string, ReactNode>): ReactNode[] {
  return message.split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={index}>{name !== undefined && name in parts ? parts[name] : piece}</Fragment>;
  });
}
