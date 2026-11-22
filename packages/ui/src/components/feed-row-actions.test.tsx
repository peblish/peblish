import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { FeedRowActions, type FeedRowSave } from './feed-row-actions.tsx';

const save: FeedRowSave = {
  label: 'Save',
  onSave: () => undefined,
  form: { action: '/saved', fields: { intent: 'save', postId: 'p1', back: '/all?sort=new&cursor=abc' }, label: 'Save Tea' },
};
const row = (disabled: boolean) =>
  renderToStaticMarkup(
    <FeedRowActions
      labels={{ more: 'More actions for Tea', list: 'Post actions', copy: 'Copy link' }}
      publishedAt="2026-11-03T23:30:00.000Z"
      locale="en"
      onCopy={() => undefined}
      status=""
      disabled={disabled}
      save={save}
    />,
  );

// Until the page has hydrated (and with scripts off) the menu cannot open: Save is a plain form in its place.
test('before hydration a row’s Save is a plain form that comes back to its address; after, the menu', () => {
  const before = row(true);
  expect(before).toContain('<form action="/saved" method="post">');
  expect(before).toContain('<input type="hidden" name="back" value="/all?sort=new&amp;cursor=abc"/>');
  expect(before).toMatch(/<button[^>]*aria-label="Save Tea"[^>]*type="submit"/);
  expect(before).not.toContain('More actions for Tea');
  const after = row(false);
  expect(after).not.toContain('<form');
  expect(after).toContain('aria-label="More actions for Tea"');
});
