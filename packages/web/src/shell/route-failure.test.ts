import { SearchParamError } from '@tanstack/react-router';
import { type } from 'arktype';
import { expect, test } from 'vitest';
import { describeRouteFailure } from './route-failure.ts';

const marker = 'MARKER-typed-by-a-visitor@example.test';

/** What the router throws when a route's ArkType validateSearch refuses the query string (router-core validateSearch). */
function searchFailure(search: Record<string, unknown>) {
  const result = type({ 'error?': 'string', 'page?': 'number.integer' })['~standard'].validate(search);
  if (result instanceof Promise || !result.issues) throw new Error('expected the search to fail');
  return new SearchParamError(JSON.stringify(result.issues, undefined, 2), { cause: result });
}

test('a search-parameter failure is one line: route, error name, and each parameter with its problem, never a value', () => {
  const line = describeRouteFailure('/post/$id/', searchFailure({ error: { a: marker }, page: marker }));
  expect(line).toBe('route /post/$id/ failed: SearchParamError (error: domain, page: domain)');
  expect(line).not.toContain(marker);
});

test('a validator that throws its own error: its name only, not its message', () => {
  const thrown = new SearchParamError(`bad ${marker}`, { cause: new TypeError(`bad ${marker}`) });
  const line = describeRouteFailure('/settings/blocks/', thrown);
  expect(line).toBe('route /settings/blocks/ failed: SearchParamError (the validator threw TypeError)');
});

test("a loader's database failure keeps the query and the code, not the parameters or quoted values", () => {
  const postgres = Object.assign(new Error(`invalid input syntax for type uuid: "${marker}"`), {
    name: 'PostgresError',
    code: '22P02',
    severity: 'ERROR',
  });
  const drizzle = Object.assign(new Error(`Failed query: select 1 from posts where id = $1\nparams: ${marker}`), {
    query: 'select 1 from posts where id = $1',
    params: [marker],
    cause: postgres,
  });
  const logged = describeRouteFailure('/post/$id/', drizzle);
  expect(logged).not.toContain(marker);
  const [first, ...frames] = logged.split('\n');
  expect(first).toBe(
    'route /post/$id/ failed: Error: Failed query: select 1 from posts where id = $1; caused by PostgresError 22P02: invalid input syntax for type uuid: "…"',
  );
  // The stack's frames stay, without its first line (the unsafe message).
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((frame) => frame.startsWith('    at '))).toBe(true);
});

test('any other error keeps its name, message and frames', () => {
  const logged = describeRouteFailure('__root__', new Error('DATABASE_URL is unset'));
  expect(logged.split('\n')[0]).toBe('route __root__ failed: Error: DATABASE_URL is unset');
  expect(describeRouteFailure('__root__', 'a string')).toBe('route __root__ failed: a thrown string');
});
