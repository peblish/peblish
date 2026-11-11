import { Input } from '@muxui/react';
import { FieldAlert, useErrorPartId, useFieldProblem } from './field-problem.tsx';
import type { HTMLInputAutoCompleteAttribute, HTMLInputTypeAttribute, ReactNode } from 'react';

export interface TextFieldProps {
  label: string;
  /** Keeps the label for assistive technology but not on screen. */
  hideLabel?: boolean;
  description?: ReactNode;
  /**
   * Shown while `invalid` is set. Without one, a value the browser refuses (required, email, link,
   * length, pattern, range) is explained in the page's language once a post is tried or the edit is committed.
   */
  errorMessage?: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  type?: Extract<HTMLInputTypeAttribute, 'text' | 'email' | 'password' | 'url' | 'tel' | 'search' | 'number'>;
  placeholder?: string;
  autoComplete?: HTMLInputAutoCompleteAttribute;
  inputMode?: 'text' | 'numeric' | 'email' | 'tel' | 'url' | 'search' | 'decimal' | 'none';
  /** `none` for a value that is not prose (a handle, a link), so a phone keyboard does not capitalise it. */
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  /** `false` for a value the spelling checker would only mark wrong. */
  spellCheck?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  /** The smallest and largest number a `number` field takes. */
  min?: number;
  max?: number;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  size?: 'sm' | 'md' | 'lg';
  autoFocus?: boolean;
  className?: string;
}

/**
 * A labelled single-line field, built on Mux UI's Input parts rather than its TextField: the
 * TextField module also carries the date, number and colour fields, which cost about 37 kB gzip
 * on every route that imports it (e2e/payload).
 */
export function TextField({
  label,
  hideLabel,
  description,
  errorMessage,
  value,
  defaultValue,
  onChange,
  name,
  type = 'text',
  placeholder,
  autoComplete,
  inputMode,
  autoCapitalize,
  spellCheck,
  maxLength,
  minLength,
  pattern,
  min,
  max,
  required,
  invalid,
  disabled,
  readOnly,
  size,
  autoFocus,
  className,
}: TextFieldProps) {
  const { ref, problem, errorId } = useFieldProblem<HTMLDivElement>();
  // The caller's message wins; otherwise the browser's verdict, which also marks the field invalid.
  const message = invalid && errorMessage ? errorMessage : problem;
  const partId = useErrorPartId(Boolean(message), errorId);
  return (
    <Input.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      required={required}
      invalid={problem !== undefined || invalid === true}
      disabled={disabled}
      readOnly={readOnly}
      size={size}
      className={className}
    >
      <Input.Label className={hideLabel ? 'pb-sr' : undefined}>{label}</Input.Label>
      <Input.Input
        name={name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        autoCapitalize={autoCapitalize}
        spellCheck={spellCheck}
        maxLength={maxLength}
        minLength={minLength}
        pattern={pattern}
        min={min}
        max={max}
        autoFocus={autoFocus}
      />
      {description && <Input.Description>{description}</Input.Description>}
      {message ? (
        <Input.Error id={partId}>
          <FieldAlert>{message}</FieldAlert>
        </Input.Error>
      ) : null}
    </Input.Root>
  );
}
