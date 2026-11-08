import { type } from 'arktype';
import { Fragment, useId, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asFormError, errorKey, type FormError } from './errors.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

/**
 * A form that posts to its route and works without JavaScript (the server answers 303).
 * Once hydrated it posts by fetch instead (Accept: application/json), so an error keeps
 * what was typed, and follows the redirect the server names with a full navigation, since
 * these forms change who is signed in.
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
        <p className="auth-error" role="alert">
          {t('auth', errorKey(error))}
        </p>
      )}
      {children}
    </form>
  );
}

/** A labelled input with an optional hint underneath, linked for screen readers. */
export function Field({
  label,
  hint,
  aside,
  ...input
}: { label: string; hint?: ReactNode; aside?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="fld">
      <div className="fld-head">
        <label htmlFor={id}>{label}</label>
        {aside}
      </div>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** A translated message whose {placeholders} are elements: links, emphasis. */
export function rich(message: string, parts: Record<string, ReactNode>): ReactNode[] {
  return message.split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={index}>{name !== undefined && name in parts ? parts[name] : piece}</Fragment>;
  });
}
