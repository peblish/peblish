import { SearchParamError } from '@tanstack/react-router';
import { type } from 'arktype';
import { afterEach, expect, test, vi } from 'vitest';
import { InputError, input } from '../server/input.ts';
import { describeRouteFailure, logRouteFailure } from './route-failure.ts';

const marker = 'MARKER-typed-by-a-visitor@example.test';

/** Everything the hook writes to the log for one failure, every argument of every call. */
function logged(routeId: string, error: unknown): string {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logRouteFailure(routeId, error);
  const text = spy.mock.calls.flat().map(String).join('\n');
  spy.mockRestore();
  return text;
}
afterEach(() => vi.restoreAllMocks());

/** What the router throws when a route's ArkType validateSearch refuses the query string (router-core validateSearch). */
function searchFailure(search: Record<string, unknown>) {
  const result = type({ 'error?': 'string', 'page?': 'number.integer' })['~standard'].validate(search);
  if (result instanceof Promise || !result.issues) throw new Error('expected the search to fail');
  return new SearchParamError(JSON.stringify(result.issues, undefined, 2), { cause: result });
}

/** What loadProfile's validator throws for a handle over 300 characters. */
function profileInputFailure(): unknown {
  try {
    input(type({ handle: 'string <= 300' }))({ handle: `${'a'.repeat(310)}${marker}` });
  } catch (error) {
    return error;
  }
  throw new Error('expected the input to fail');
}

test('a search-parameter failure is one line: route, error name, and each parameter with its problem, never a value', () => {
  const text = logged('/post/$id/', searchFailure({ error: { a: marker }, page: marker }));
  expect(text).toBe('route /post/$id/ failed: SearchParamError (error: domain, page: domain)');
});

test("a server function's refused input is named the same way (a profile's handle too long)", () => {
  const error = profileInputFailure();
  expect(error).toBeInstanceOf(InputError);
  expect(logged('/u/$handle/', error)).toBe('route /u/$handle/ failed: InputError (handle: maxLength)');
});

test('the same failure flattened by TanStack into a message (a validator that is not wrapped) logs no value', () => {
  // TanStack's execValidator: throw new Error(JSON.stringify(result.issues)), the issues' data included.
  const issues = type({ handle: 'string <= 300' })['~standard'].validate({ handle: `${'a'.repeat(310)}${marker}` });
  const text = logged('/u/$handle/', new Error(JSON.stringify('issues' in issues ? issues.issues : [], undefined, 2)));
  expect(text).not.toContain(marker);
  expect(text).not.toMatch(/[\r\n]/);
  expect(text).toMatch(/^route \/u\/\$handle\/ failed: Error( at \S+)?$/);
});

test("a message the app built from the visitor's input is never logged", () => {
  const text = logged('/c/$handle/', new Error(`no such community: ${marker}`));
  expect(text).not.toContain(marker);
  expect(text).toMatch(/^route \/c\/\$handle\/ failed: Error( at \S+)?$/);
});

test('a validator that throws its own error: its name only', () => {
  const thrown = new SearchParamError(`bad ${marker}`, { cause: new TypeError(`bad ${marker}`) });
  expect(describeRouteFailure('/settings/blocks/', thrown)).toBe(
    'route /settings/blocks/ failed: SearchParamError (the validator threw TypeError)',
  );
});

test('a database failure is one line with the class, code and place, and no line break', () => {
  const postgres = Object.assign(new Error(`invalid input syntax for type uuid: "${marker}"`), { name: 'PostgresError', code: '22P02' });
  const drizzle = new Error(`Failed query: select 1 from posts\nwhere id = $1\nparams: ${marker}`, { cause: postgres });
  const text = logged('/post/$id/', drizzle);
  expect(text).not.toMatch(/[\r\n]/);
  expect(text).not.toContain(marker);
  expect(text).toMatch(
    /^route \/post\/\$id\/ failed: Error at web\/src\/shell\/route-failure\.test\.ts:\d+; caused by PostgresError 22P02$/,
  );
});
