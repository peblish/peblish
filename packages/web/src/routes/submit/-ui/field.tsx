import { Input } from '@peblish/ui/components/input';
import type { ReactNode } from 'react';

/**
 * A single-line composer field whose error is told the way the form's other checks are: beside
 * the field, as its description and as an alert, on Mux UI's Input parts. The error part has no
 * id of its own, so Mux links it whether the server rendered it or it appears after hydration.
 */
export function ComposerField({
  label,
  name,
  type = 'text',
  placeholder,
  value,
  onChange,
  description,
  invalid,
  error,
  className,
}: {
  label: string;
  name: string;
  type?: 'text' | 'url';
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  description?: ReactNode;
  invalid: boolean;
  /** Shown while `invalid` is set. */
  error?: ReactNode;
  className?: string;
}) {
  return (
    <Input.Root value={value} onChange={onChange} invalid={invalid} className={className}>
      <Input.Label>{label}</Input.Label>
      <Input.Input name={name} type={type} placeholder={placeholder} />
      {description && <Input.Description>{description}</Input.Description>}
      {invalid && error && <Input.Error role="alert">{error}</Input.Error>}
    </Input.Root>
  );
}
