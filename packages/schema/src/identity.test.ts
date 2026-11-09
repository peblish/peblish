import { expect, test } from 'vitest';
import { ageOn, dateOfBirth } from './identity.ts';

const now = new Date('2026-11-08T12:00:00Z');

test('the age turns on the birthday, by the UTC calendar', () => {
  expect(ageOn({ year: 2010, month: 11, day: 8 }, now)).toBe(16);
  expect(ageOn({ year: 2010, month: 11, day: 9 }, now)).toBe(15);
  expect(ageOn({ year: 2010, month: 12, day: 1 }, now)).toBe(15);
  expect(ageOn({ year: 1990, month: 2, day: 28 }, now)).toBe(36);
});

test('only a real, past date of birth counts', () => {
  expect(dateOfBirth('8', '11', '2010', now)).toEqual({ year: 2010, month: 11, day: 8 });
  for (const [day, month, year] of [
    ['30', '2', '2000'],
    ['', '1', '2000'],
    ['1', '13', '2000'],
    ['9', '11', '2026'],
    ['1', '1', '1899'],
    ['1e1', '1', '2000'],
  ] as const)
    expect(dateOfBirth(day, month, year, now), `${day}.${month}.${year}`).toBeNull();
});
