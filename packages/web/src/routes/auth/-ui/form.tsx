import { Input } from '@peblish/ui/components/input';
import { Notice } from '@peblish/ui/components/notice';
import { type } from 'arktype';
import { Fragment, useState, type FormEvent, type FocusEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asFormError, errorKey, type FormError } from './errors.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

/**
 * A form that posts to its route and works without JavaScript (the server answers 303).
 * Once hydrated it posts by fetch instead (Accept: application/json), so an error keeps
 * what was typed, and follows the redirect the server names with a full navigation, since
 * these forms change who is signed in. The error shows first, as a danger Notice.
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget, submitter)) if (typeof value === 'string') body.append(name, value);
    setBusy(true);
    try {
      const response = await fetch(action, { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return setError('generic');
      if (answer.redirect) return window.location.assign(answer.redirect);
      setError(asFormError(answer.error) ?? 'generic');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" action={action} aria-label={label} aria-busy={busy} className={className} onSubmit={submit}>
      {error && (
        <Notice tone="danger" role="alert">
          {t('auth', errorKey(error))}
        </Notice>
      )}
      {children}
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
 * follows the browser's language, not the page's). The message goes as soon as a keystroke makes
 * the value valid, not at the blur: the press on the submit button below is what blurs the field,
 * and a message going then moves the button between the press and the release, losing the click
 * (the shared fields do the same, `nextProblem` in @peblish/ui field-problem). A blur re-judges
 * a message still showing. Without JavaScript the browser validates as it always does.
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
  const text = (given: typeof value) => (given === undefined ? undefined : String(given));
  const explain = (field: HTMLInputElement) => {
    const { validity } = field;
    if (validity.valid) return undefined;
    if (validity.valueMissing) return t('auth', 'field.required');
    if (validity.typeMismatch && field.type === 'email') return t('auth', 'field.email');
    if (validity.tooShort) return t('auth', 'field.tooShort', { min: field.minLength });
    if (validity.tooLong) return t('auth', 'field.tooLong', { max: field.maxLength });
    return t('auth', 'field.invalid');
  };
  return (
    <Input.Root
      className="auth-field"
      value={text(value)}
      defaultValue={text(defaultValue)}
      required={required}
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
          if (problem !== undefined && explain(event.currentTarget) === undefined) setProblem(undefined);
        }}
        onBlur={(event: FocusEvent<HTMLInputElement>) => {
          input.onBlur?.(event);
          if (problem !== undefined) setProblem(explain(event.currentTarget));
        }}
      />
      {hint && <Input.Description>{hint}</Input.Description>}
      {problem !== undefined && <Input.Error role="alert">{problem}</Input.Error>}
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
