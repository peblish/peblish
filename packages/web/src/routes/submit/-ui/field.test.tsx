import { alertsOf, controlTag, descriptionOf } from '@peblish/ui/components/field-markup.testing.ts';
import { renderToString } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

// The server's markup, as a browser without scripts (or before hydration) gets it: a refusal the
// server rendered must already be the control's description, and announced once.
vi.mock('../../../i18n/use-translate.ts', () => ({ useTranslate: () => ({ locale: 'en', t: (_area: string, key: string) => key }) }));

const { ComposerField } = await import('./field.tsx');
const { ImageField } = await import('./image-field.tsx');

test('a composer field refused on the server is described by its error in the server markup', () => {
  const html = renderToString(
    <ComposerField label="Link" name="url" value="nope" onChange={() => {}} description="A full link" invalid error="Not a link." />,
  );
  expect(controlTag(html, 'input')).toContain('aria-invalid="true"');
  expect(descriptionOf(html, 'input')).toEqual(expect.arrayContaining(['A full link', 'Not a link.']));
  expect(alertsOf(html)).toEqual(['Not a link.']);
});

test('the image field refused on the server is described by its error in the server markup', () => {
  const html = renderToString(<ImageField error="Too large." progress={null} />);
  expect(descriptionOf(html, 'input')).toEqual(expect.arrayContaining(['image.hint', 'Too large.']));
  expect(alertsOf(html)).toEqual(['Too large.']);
});

test('a valid composer field renders no error part', () => {
  const html = renderToString(
    <ComposerField label="Title" name="title" value="" onChange={() => {}} invalid={false} error="Never shown" />,
  );
  expect(html).not.toContain('Never shown');
  expect(alertsOf(html)).toEqual([]);
});
