import { CheckboxField } from '@muxui/react';
import type { ReactNode } from 'react';

export interface CheckboxProps {
  /** The label. */
  children: ReactNode;
  description?: ReactNode;
  /** Shown while `invalid` is set. */
  errorMessage?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  name?: string;
  value?: string;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** A checkbox with its label, built on Mux UI's CheckboxField (the React Aria Checkbox costs 14 kB gzip more). */
export function Checkbox({ children, description, errorMessage, invalid, ...rest }: CheckboxProps) {
  return (
    <CheckboxField.Root invalid={invalid} {...rest}>
      <CheckboxField.Button>
        <CheckboxField.Indicator />
        {children}
      </CheckboxField.Button>
      {description && <CheckboxField.Description>{description}</CheckboxField.Description>}
      {invalid && errorMessage && <CheckboxField.Error>{errorMessage}</CheckboxField.Error>}
    </CheckboxField.Root>
  );
}
