import { expect, test, type Locator } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// A field whose caller changes what was typed (here it trims it) judges the value React keeps,
// not the keystroke: after a blocked submit, a typed space is written back as nothing, so the
// field is still empty and keeps its message; a typed letter clears it. The fields are the
// kit's (routes/kit/-trimmed-fields.tsx): both text wrappers and the admin CheckedInput.
const message = 'Fill in this field.';

/** The field's own message: an alert that is also its accessible description. */
const explained = (control: Locator) => expect(control).toHaveAccessibleDescription(new RegExp(message.replace('.', '\\.')));

test('a trimmed space keeps the message, a letter clears it, in every text field', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const form = page.getByTestId('kit-trimmed');
  const fields = [
    form.getByRole('textbox', { name: 'Trimmed text field' }),
    form.getByRole('textbox', { name: 'Trimmed text area' }),
    form.getByRole('textbox', { name: 'Trimmed checked input' }),
  ];
  await form.getByRole('button', { name: 'Send trimmed' }).click();
  await expect(form.getByRole('alert').filter({ hasText: message })).toHaveCount(3);
  await expect(fields[0]!).toBeFocused();

  for (const [index, field] of fields.entries()) {
    await field.focus();
    await field.press('Space');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await explained(field);
    await expect(form.getByRole('alert').filter({ hasText: message })).toHaveCount(3 - index);

    await field.press('a');
    await expect(field).toHaveValue('a');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByRole('alert').filter({ hasText: message })).toHaveCount(2 - index);
    await expect(field).toBeFocused();
  }
  await expect(form.getByTestId('kit-trimmed-sent')).toHaveText('0');
});
