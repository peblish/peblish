import { TextArea } from '@muxui/react';
import type { ReactNode } from 'react';

export interface TextAreaFieldProps {
  label: string;
  /** Keeps the label for assistive technology but not on screen (a docked reply bar, a search box). */
  hideLabel?: boolean;
  description?: ReactNode;
  /** Shown while `invalid` is set. */
  errorMessage?: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
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
  required,
  invalid,
  disabled,
  readOnly,
  size,
  autoFocus,
  className,
}: TextAreaFieldProps) {
  return (
    <TextArea.Root
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
      <TextArea.Label className={hideLabel ? 'pb-sr' : undefined}>{label}</TextArea.Label>
      <TextArea.TextArea name={name} rows={rows} placeholder={placeholder} maxLength={maxLength} autoFocus={autoFocus} />
      {description && <TextArea.Description>{description}</TextArea.Description>}
      {invalid && errorMessage && <TextArea.Error>{errorMessage}</TextArea.Error>}
    </TextArea.Root>
  );
}
