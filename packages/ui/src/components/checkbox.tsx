import { CheckboxField } from '@muxui/react';
import type { ReactNode } from 'react';
import { useFieldProblem } from './field-problem.tsx';

export interface CheckboxProps {
  /** The label. */
  children: ReactNode;
  description?: ReactNode;
  /**
   * Shown while `invalid` is set. Without one, a required box left unticked is explained in the
   * page's language once a post is tried, and the message goes when the box is ticked.
   */
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
export function Checkbox({ children, description, errorMessage, invalid, onChange, ...rest }: CheckboxProps) {
  const { ref, problem, recheck } = useFieldProblem<HTMLDivElement>();
  // The caller's message wins; otherwise the browser's verdict, which also marks the box invalid.
  const message = invalid && errorMessage ? errorMessage : problem;
  return (
    <CheckboxField.Root
      ref={ref}
      invalid={problem !== undefined || invalid === true}
      onChange={(checked: boolean) => {
        onChange?.(checked);
        recheck();
      }}
      {...rest}
    >
      <CheckboxField.Button>
        <CheckboxField.Indicator />
        {children}
      </CheckboxField.Button>
      {description && <CheckboxField.Description>{description}</CheckboxField.Description>}
      {message ? <CheckboxField.Error role="alert">{message}</CheckboxField.Error> : null}
    </CheckboxField.Root>
  );
}
