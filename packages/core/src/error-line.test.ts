import { expect, test } from 'vitest';
import { errorLine, issueSummary } from './error-line.ts';

const marker = 'MARKER-typed@example.test';

test('an error is described by its class, code, first frame in the app and causes, never its message', () => {
  const postgres = Object.assign(new Error(`invalid input syntax for type uuid: "${marker}"`), { name: 'PostgresError', code: '22P02' });
  const drizzle = Object.assign(new Error(`Failed query: select 1\nparams: ${marker}`), { cause: postgres });
  class DrizzleQueryError extends Error {}
  const wrapped = Object.setPrototypeOf(drizzle, DrizzleQueryError.prototype) as Error;
  wrapped.stack = [
    `Error: Failed query: select 1`,
    `params: ${marker}`,
    '    at PostgresJsPreparedQuery.queryWithCache (file:///app/node_modules/drizzle-orm/pg-core/session.js:41:15)',
    '    at async readProfile (file:///app/packages/core/src/profiles/read.ts:88:17)',
  ].join('\n');
  const line = errorLine(wrapped);
  expect(line).toBe('DrizzleQueryError at core/src/profiles/read.ts:88; caused by PostgresError 22P02');
  expect(line).not.toContain(marker);
});

test('the built server names its chunk; library and Node frames are skipped, and no frame means no location', () => {
  const error = new Error(marker);
  error.stack = [
    `Error: ${marker}`,
    '    at execValidator (file:///app/packages/web/.output/server/_libs/h3+srvx.mjs:5:1)',
    '    at node:internal/process/task_queues:104:5',
    '    at file:///app/packages/web/.output/server/_ssr/-load-2Usr40OX.mjs:138:11',
  ].join('\n');
  expect(errorLine(error)).toBe('Error at _ssr/-load-2Usr40OX.mjs:138');
  const bare = new TypeError(marker);
  bare.stack = `TypeError: ${marker}`;
  expect(errorLine(bare)).toBe('TypeError');
});

test('the line is one physical line, and a name or code that could carry input is left out', () => {
  const odd = Object.assign(new Error(`x\n${marker}`), { name: `Bad\nName ${marker}`, code: `E ${marker}` });
  const line = errorLine(odd);
  expect(line).not.toMatch(/[\r\n]/);
  expect(line).not.toContain(marker);
  // An SMTP refusal names the recipient in its message and response: neither is read.
  const smtp = Object.assign(new Error(`Can't send mail - all recipients were rejected: 550 <${marker}>`), {
    code: 'EENVELOPE',
    response: `550 5.1.1 <${marker}>: Recipient address rejected`,
  });
  expect(errorLine(smtp)).toMatch(/^Error EENVELOPE( at \S+)?$/);
  expect(errorLine('a string with ' + marker)).toBe('a thrown string');
});

test('validation issues: each path with its code, never a value', () => {
  expect(issueSummary([{ path: ['handle'], code: 'maxLength' }, { path: [{ key: 'a' }, 0], code: 'domain' }, { path: [] }])).toBe(
    'handle: maxLength, a.0: domain, (all): invalid',
  );
});
