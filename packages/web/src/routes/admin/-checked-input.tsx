import { useFieldProblem } from '@peblish/ui/components/field-problem';
import { Input } from '@peblish/ui/components/input';
import type { ComponentProps } from 'react';

type InputAttributes = Pick<
  ComponentProps<typeof Input.Input>,
  'name' | 'type' | 'className' | 'autoComplete' | 'spellCheck' | 'placeholder'
>;

/**
 * A labelled field on Mux's Input parts that explains a value the browser refuses (empty when
 * required, a bad date) under itself in the page's language, as the app's TextField does. For the
 * fields TextField does not take: a native date input, and a mono hash field without spell checking.
 */
export function CheckedInput({
  label,
  value,
  defaultValue,
  onChange,
  required,
  ...input
}: InputAttributes & { label: string; value?: string; defaultValue?: string; onChange?: (value: string) => void; required?: boolean }) {
  const { ref, problem } = useFieldProblem<HTMLDivElement>();
  return (
    <Input.Root ref={ref} value={value} defaultValue={defaultValue} onChange={onChange} required={required} invalid={problem !== undefined}>
      <Input.Label>{label}</Input.Label>
      <Input.Input {...input} />
      {problem !== undefined && <Input.Error role="alert">{problem}</Input.Error>}
    </Input.Root>
  );
}
