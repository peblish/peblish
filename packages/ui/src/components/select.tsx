import { SelectNative } from '@muxui/react';
import type { ReactNode } from 'react';

export interface SelectItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: string;
  description?: ReactNode;
  /** Shown while `invalid` is set. */
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
export function Select({ label, description, errorMessage, items, onChange, placeholder, className, ...rest }: SelectProps) {
  return (
    <SelectNative
      label={label}
      description={description}
      errorMessage={errorMessage}
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
