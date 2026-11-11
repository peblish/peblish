import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Badge } from './badge.tsx';

const labels = { admin: 'ADMIN', moderator: 'MOD', op: 'OP' };

test('a role badge takes its text from the labels and keeps its role class', () => {
  expect(renderToStaticMarkup(<Badge kind="moderator" labels={labels} />)).toBe('<span class="pb-badge pb-badge--moderator">MOD</span>');
  expect(renderToStaticMarkup(<Badge kind="op" labels={labels} />)).toContain('pb-badge--op">OP<');
});

test('a named state gets its fixed tone, and tone overrides it', () => {
  expect(renderToStaticMarkup(<Badge kind="nsfw">NSFW</Badge>)).toBe('<span class="pb-badge pb-badge--danger">NSFW</span>');
  expect(renderToStaticMarkup(<Badge kind="pinned">Pinned</Badge>)).toContain('pb-badge--brand');
  expect(renderToStaticMarkup(<Badge kind="removed">Removed</Badge>)).toContain('pb-badge--warning');
  expect(
    renderToStaticMarkup(
      <Badge kind="locked" tone="success">
        Locked
      </Badge>,
    ),
  ).toContain('pb-badge--success');
  expect(renderToStaticMarkup(<Badge>Fixed</Badge>)).toContain('pb-badge--neutral');
});

test('a count passes its accessible name through', () => {
  const html = renderToStaticMarkup(
    <Badge tone="brand" role="img" aria-label="3 unread">
      3
    </Badge>,
  );
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="3 unread"');
});

test('native attributes reach the span', () => {
  const html = renderToStaticMarkup(
    <Badge id="b" data-testid="badge" aria-describedby="note">
      New
    </Badge>,
  );
  expect(html).toBe('<span id="b" data-testid="badge" aria-describedby="note" class="pb-badge pb-badge--neutral">New</span>');
});
