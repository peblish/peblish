import { Text } from '@peblish/ui/components/text';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { TextField } from '@peblish/ui/components/text-field';
import { useState } from 'react';

/**
 * Fields that start with saved text, controlled and uncontrolled, counting every onChange they
 * make, for the e2e check that a field nobody typed into changes nothing as it hydrates (the
 * fields keep what was typed before hydration, and must stay silent when nothing was).
 */
export function SavedFields() {
  const [changes, setChanges] = useState(0);
  const [line, setLine] = useState('Saved line');
  const [lines, setLines] = useState('Saved words');
  const count = () => setChanges((total) => total + 1);
  return (
    <form aria-label="Saved fields" className="kit-stack" data-testid="kit-saved">
      <TextField label="Saved text field" name="line" defaultValue="Saved line" onChange={count} />
      <TextAreaField label="Saved text area" name="lines" rows={2} defaultValue="Saved words" onChange={count} />
      <TextField
        label="Controlled saved text field"
        name="controlledLine"
        value={line}
        onChange={(next) => {
          setLine(next);
          count();
        }}
      />
      <TextAreaField
        label="Controlled saved text area"
        name="controlledLines"
        rows={2}
        value={lines}
        onChange={(next) => {
          setLines(next);
          count();
        }}
      />
      <Text as="p" data-testid="kit-saved-changes">
        {changes}
      </Text>
    </form>
  );
}
