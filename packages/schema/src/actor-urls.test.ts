import { expect, test } from 'vitest';
import { actorPagePath, newActorApId, newObjectApId } from './actor-urls.ts';

test('new local actors live under /ap/u. and /ap/c. with human pages at /u/ and /c/', () => {
  expect(newActorApId('https://feddit.com', 'Person', 'Andrew')).toBe('https://feddit.com/ap/u.Andrew');
  expect(newActorApId('https://feddit.com', 'Group', 'announcements')).toBe('https://feddit.com/ap/c.announcements');
  expect(actorPagePath('Person', 'Andrew')).toBe('/u/Andrew');
  expect(actorPagePath('Group', 'microblogs')).toBe('/c/microblogs');
  expect(newObjectApId('https://feddit.com', 'post', 'abc')).toBe('https://feddit.com/ap/post/abc');
});

test('new actor names are limited to [A-Za-z0-9_]', () => {
  // Imported actors such as feddit-admin keep their stored ap_id and never pass through here.
  expect(() => newActorApId('https://feddit.com', 'Person', 'feddit-admin')).toThrow(RangeError);
  expect(() => newActorApId('https://feddit.com', 'Person', '')).toThrow(RangeError);
});
