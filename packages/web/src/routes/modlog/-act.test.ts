import { expect, test } from 'vitest';
import { answer, backTo, banEnd, readReason } from './-act.ts';

const now = Date.parse('2026-11-09T10:00:00.000Z');

test('a ban ends in 1, 7 or 30 days, on a custom day, or never; a past or unreadable day is refused', () => {
  expect(banEnd({ duration: '7' }, now)).toBe('2026-11-16T10:00:00.000Z');
  expect(banEnd({ duration: '1' }, now)).toBe('2026-11-10T10:00:00.000Z');
  expect(banEnd({ duration: 'permanent' }, now)).toBeNull();
  expect(banEnd({}, now)).toBeNull();
  expect(banEnd({ duration: 'custom', until: '2026-12-01' }, now)).toBe('2026-12-01T23:59:59.000Z');
  expect(banEnd({ duration: 'custom', until: '2026-11-09' }, now)).toBe('2026-11-09T23:59:59.000Z');
  expect(banEnd({ duration: 'custom', until: '2026-11-08' }, now)).toBeUndefined();
  expect(banEnd({ duration: 'custom', until: 'soon' }, now)).toBeUndefined();
  expect(banEnd({ duration: 'custom' }, now)).toBeUndefined();
});

test('a reason is trimmed, empty is null, and over 10,000 characters is refused', () => {
  expect(readReason('  Spam  ')).toBe('Spam');
  expect(readReason('   ')).toBeNull();
  expect(readReason(undefined)).toBeNull();
  expect(readReason('x'.repeat(10_001))).toBeUndefined();
});

test('a refusal goes back to the page with its code and panel, replacing an earlier one and keeping the rest', () => {
  expect(backTo('/post/1?sort=new#comment-2', { ok: false, reason: 'target.removed' }, 'remove:2')).toBe(
    '/post/1?sort=new&modError=target.removed&modFor=remove%3A2#comment-2',
  );
  expect(backTo('/post/1?modError=old&modFor=x', { ok: true }, 'remove:2')).toBe('/post/1');
});

test('the answer is JSON for a fetch and a 303 for a form post', async () => {
  const json = answer(
    new Request('http://x/modlog/act', { headers: { accept: 'application/json' } }),
    [],
    { ok: false, reason: 'target.removed' },
    '/p',
    'k',
  );
  expect([json.status, await json.json()]).toEqual([400, { error: 'target.removed' }]);
  const form = answer(new Request('http://x/modlog/act'), ['a=b'], { ok: true }, '/p', 'k');
  expect([form.status, form.headers.get('location'), form.headers.get('set-cookie')]).toEqual([303, '/p', 'a=b']);
});
