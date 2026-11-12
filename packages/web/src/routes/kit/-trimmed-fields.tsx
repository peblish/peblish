import { Button } from '@peblish/ui/components/button';
import { Text } from '@peblish/ui/components/text';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { TextField } from '@peblish/ui/components/text-field';
import { useState, type FormEvent } from 'react';
import { CheckedInput } from '../admin/-checked-input.tsx';

/**
 * Required fields whose callers keep only what is left after trimming what was typed, for the
 * e2e check that a field's message goes only once the value React keeps is valid: a typed space
 * is written back as nothing, so the field stays empty and keeps its message.
 */
export function TrimmedFields() {
  const [line, setLine] = useState('');
  const [lines, setLines] = useState('');
  const [checked, setChecked] = useState('');
  const [sent, setSent] = useState(0);
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSent((count) => count + 1);
  };
  return (
    <form aria-label="Trimmed fields" className="kit-stack" data-testid="kit-trimmed" onSubmit={send}>
      <TextField label="Trimmed text field" name="line" required value={line} onChange={(next) => setLine(next.trim())} />
      <TextAreaField label="Trimmed text area" name="lines" rows={2} required value={lines} onChange={(next) => setLines(next.trim())} />
      <CheckedInput label="Trimmed checked input" name="checked" required value={checked} onChange={(next) => setChecked(next.trim())} />
      <Button type="submit" variant="primary">
        Send trimmed
      </Button>
      <Text as="p" data-testid="kit-trimmed-sent">
        {sent}
      </Text>
    </form>
  );
}
