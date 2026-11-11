import { SelectNative } from '@muxui/react';
import type { ReactNode } from 'react';
import { useFieldProblem } from './field-problem.tsx';

export interface SelectItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: string;
  description?: ReactNode;
  /**
   * Shown while `invalid` is set. Without one, a required select left on its empty choice is
   * explained in the page's language once a post is tried, in place of the browser's bubble.
   */
  errorMessage?: ReactNode;
  /** Plain strings stand for themselves; an object has an `id` (the value) and a `label`. */
  items: readonly (string | SelectItem)[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  name?: string;
  /** An empty first option shown while nothing is chosen. */
  placeholder?: string;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * A labelled select, built on Mux UI's native select: the browser's own menu, which works on a
 * first tap before hydration and costs 1 kB gzip. Its popup-based Select costs about 60 kB, so
 * it is not offered; lane notes say how to ask for it where a custom list is worth that.
 */
export function Select({ label, description, errorMessage, items, onChange, placeholder, invalid, className, ...rest }: SelectProps) {
  // The native select is not React Aria's, so the hook also stops the browser's bubble and moves focus.
  const { ref, problem } = useFieldProblem<HTMLSelectElement>({ native: true });
  // The caller's message wins; otherwise the browser's verdict. SelectNative links the message
  // itself and gives its part no role, so the alert is a span inside it.
  const message = invalid && errorMessage ? errorMessage : problem;
  return (
    <SelectNative
      ref={ref}
      label={label}
      description={description}
      errorMessage={message ? <span role="alert">{message}</span> : undefined}
      invalid={problem !== undefined || invalid === true}
      className={className}
      onChange={(event) => onChange?.(event.target.value)}
      {...rest}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {items.map((item) => {
        const option = typeof item === 'string' ? { id: item, label: item } : item;
        return (
          <option key={option.id} value={option.id} disabled={option.disabled}>
            {option.label}
          </option>
        );
      })}
    </SelectNative>
  );
}
