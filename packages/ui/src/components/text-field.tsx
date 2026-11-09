import { Input } from '@muxui/react';
import type { HTMLInputAutoCompleteAttribute, HTMLInputTypeAttribute, ReactNode } from 'react';

export interface TextFieldProps {
  label: string;
  /** Keeps the label for assistive technology but not on screen. */
  hideLabel?: boolean;
  description?: ReactNode;
  /** Shown while `invalid` is set. */
  errorMessage?: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  type?: Extract<HTMLInputTypeAttribute, 'text' | 'email' | 'password' | 'url' | 'tel' | 'search' | 'number'>;
  placeholder?: string;
  autoComplete?: HTMLInputAutoCompleteAttribute;
  inputMode?: 'text' | 'numeric' | 'email' | 'tel' | 'url' | 'search' | 'decimal' | 'none';
  maxLength?: number;
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
  maxLength,
  required,
  invalid,
  disabled,
  readOnly,
  size,
  autoFocus,
  className,
}: TextFieldProps) {
  return (
    <Input.Root
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      required={required}
      invalid={invalid}
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
        maxLength={maxLength}
        autoFocus={autoFocus}
      />
      {description && <Input.Description>{description}</Input.Description>}
      {invalid && errorMessage && <Input.Error>{errorMessage}</Input.Error>}
    </Input.Root>
  );
}
