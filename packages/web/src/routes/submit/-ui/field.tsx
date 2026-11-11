import { Input } from '@peblish/ui/components/input';
import { useId, type ReactNode } from 'react';

/**
 * A single-line composer field whose error is told the way the form's other checks are: beside
 * the field, as its description and as an alert. Built on Mux UI's Input parts rather than the
 * shared TextField because of two gaps there. Once hydrated, React Aria keeps the browser's own
 * validation bubble away, so the message has to be announced by the page. And Mux UI's Input
 * links an error to the field by the id the error has when it mounts, while React Aria names an
 * error that appears later only a render after that, so the link is never made: the id is given
 * here (as in image-field.tsx).
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
  const errorId = useId();
  return (
    <Input.Root value={value} onChange={onChange} invalid={invalid} className={className}>
      <Input.Label>{label}</Input.Label>
      <Input.Input name={name} type={type} placeholder={placeholder} />
      {description && <Input.Description>{description}</Input.Description>}
      {invalid && error && (
        <Input.Error id={errorId} role="alert">
          {error}
        </Input.Error>
      )}
    </Input.Root>
  );
}
