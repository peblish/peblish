import { expect, test } from 'vitest';
import { parseViewCookie } from './-view.ts';

test('the directory view is Cards only when its cookie says so', () => {
  expect(parseViewCookie('a=1; peblish_dir_view=cards; b=2')).toBe('cards');
  expect(parseViewCookie('peblish_dir_view=list')).toBe('list');
  expect(parseViewCookie('peblish_dir_view=grid')).toBe('list');
  expect(parseViewCookie('peblish_dir_view_other=cards')).toBe('list');
  expect(parseViewCookie(undefined)).toBe('list');
});
