import { expect, test } from 'vitest';
import { logLine, oneLine } from './log-line.ts';

const marker = 'MARKER-typed@example.test';

test('an error argument is its errorLine, and an object holding one reports that error', () => {
  const error = Object.assign(new Error(`relation quoted ${marker}`), { code: '22021' });
  expect(logLine(['failed', error])).toMatch(/^failed Error 22021( at \S+)?$/);
  expect(logLine([{ error }])).toMatch(/^Error 22021( at \S+)?$/);
  // srvx: console.error(error, { cause: { req, handler } }).
  expect(logLine([error, { cause: { req: { url: `/x?q=${marker}` } } }])).toMatch(/^Error 22021( at \S+)? \[Object\]$/);
});

test('any other object is its type name, never its fields', () => {
  const line = logLine(['request', new Request(`https://feddit.test/?q=${marker}`), { email: marker }, [marker], () => marker]);
  expect(line).toBe('request [Request] [Object] [Array] [function]');
});

test('strings and formats keep their text on one line, without control characters or colours', () => {
  expect(logLine(['a\nb\r\nc\u0000d', 'e'])).toBe('a b c d e');
  expect(logLine(['%s failed with %d', 'job', 3])).toBe('job failed with 3');
  expect(oneLine('\u001b[2m2026\u001b[0m WARN')).toBe('2026 WARN');
  expect(logLine(['x'.repeat(5_000)]).length).toBe(2_000);
});
