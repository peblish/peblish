import { TextArea } from './mux-text-area.tsx';
import { useFieldProblem } from './field-problem.tsx';
import type { ReactNode } from 'react';

export interface TextAreaFieldProps {
  label: string;
  /** Keeps the label for assistive technology but not on screen (a docked reply bar, a search box). */
  hideLabel?: boolean;
  description?: ReactNode;
  /**
   * Shown while `invalid` is set. Without one, a value the browser refuses (required, length) is
   * explained in the page's language once a post is tried or the edit is committed, and goes as
   * soon as a keystroke makes the value valid.
   */
  errorMessage?: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  minLength?: number;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  size?: 'sm' | 'md' | 'lg';
  autoFocus?: boolean;
  className?: string;
}

/** A labelled multi-line field: Mux UI's TextArea parts put together, with the label tied to the control. */
export function TextAreaField({
  label,
  hideLabel,
  description,
  errorMessage,
  value,
  defaultValue,
  onChange,
  name,
  rows,
  placeholder,
  maxLength,
  minLength,
  required,
  invalid,
  disabled,
  readOnly,
  size,
  autoFocus,
  className,
}: TextAreaFieldProps) {
  const { ref, problem, settle } = useFieldProblem<HTMLDivElement>();
  // The caller's message wins; otherwise the browser's verdict, which also marks the field invalid.
  const message = invalid && errorMessage ? errorMessage : problem;
  return (
    <TextArea.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      onChange={(next: string) => {
        onChange?.(next);
        settle();
      }}
      required={required}
      invalid={problem !== undefined || invalid === true}
      disabled={disabled}
      readOnly={readOnly}
      size={size}
      className={className}
    >
      <TextArea.Label className={hideLabel ? 'pb-sr' : undefined}>{label}</TextArea.Label>
      <TextArea.TextArea
        name={name}
        rows={rows}
        placeholder={placeholder}
        maxLength={maxLength}
        minLength={minLength}
        autoFocus={autoFocus}
      />
      {description && <TextArea.Description>{description}</TextArea.Description>}
      {message ? <TextArea.Error role="alert">{message}</TextArea.Error> : null}
    </TextArea.Root>
  );
}
