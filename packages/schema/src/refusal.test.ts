import { expect, test } from 'vitest';
import { RefusalReason, describeRefusal, refusalReasons } from './refusal.ts';

test('the refusal union is closed', () => {
  expect(refusalReasons).toContain('auth.required');
  expect(RefusalReason('auth.required')).toBe('auth.required');
  expect(RefusalReason.allows('made.up')).toBe(false);
  expect(describeRefusal('site.disabled')).toMatch(/kill switch/);
});
