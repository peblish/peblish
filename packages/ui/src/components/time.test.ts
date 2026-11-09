import { expect, test } from 'vitest';
import { absoluteTime, compactAge } from './time.tsx';

const now = new Date('2026-11-09T12:00:00Z');

test('ages are the largest whole unit, at least a minute, in the locale', () => {
  expect(compactAge('2026-11-09T11:59:40Z', now, 'en-US')).toBe('1m');
  expect(compactAge('2026-11-09T09:00:00Z', now, 'en-US')).toBe('3h');
  expect(compactAge('2026-11-08T12:00:00Z', now, 'en-US')).toBe('1d');
  expect(compactAge('2026-11-09T09:00:00Z', now, 'de-DE')).toMatch(/^3\s*(h|Std)/);
  // A time in the future (clock skew) reads as the minimum, not a negative age.
  expect(compactAge('2026-11-09T12:05:00Z', now, 'en-US')).toBe('1m');
});

// Browsers throw a TypeError when dateStyle or timeStyle meets timeZoneName, so the absolute time
// uses explicit fields; the same text must come out on the server and in the browser (UTC).
test('the absolute time is in UTC, with the zone named, in the locale', () => {
  expect(absoluteTime('2026-11-09T12:00:00Z', 'en-US')).toBe('Nov 9, 2026, 12:00 PM UTC');
  expect(absoluteTime('2026-11-09T12:00:00Z', 'de-DE')).toBe('9. Nov. 2026, 12:00 UTC');
});

test('the absolute time never combines a style with a zone name', () => {
  const real = Intl.DateTimeFormat;
  const options: Intl.DateTimeFormatOptions[] = [];
  Intl.DateTimeFormat = new Proxy(real, {
    construct(target, args: [string, Intl.DateTimeFormatOptions]) {
      options.push(args[1]);
      return new target(...args);
    },
  });
  try {
    absoluteTime('2026-11-09T12:00:00Z', 'fr-FR');
  } finally {
    Intl.DateTimeFormat = real;
  }
  expect(options).toHaveLength(1);
  expect(options[0]).toHaveProperty('timeZoneName');
  expect(options[0]).not.toHaveProperty('dateStyle');
  expect(options[0]).not.toHaveProperty('timeStyle');
});
