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

test("a forged frame in a real database error's message gives no location from it", async () => {
  // What a decoded query-string value can hold: a NUL that Postgres refuses, and a line shaped like a frame.
  const forged = `x\0\n    at /app/packages/${marker}.ts:1:1\nx`;
  const { db } = await import('./db/read.ts');
  const { sql } = await import('drizzle-orm');
  const failure = await db()
    .execute(sql`select ${forged}::text as value`)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(Error);
  // The driver's message does carry the value, so the stack does too.
  expect(String((failure as Error).stack)).toContain(marker);
  const line = errorLine(failure);
  expect(line).not.toContain(marker);
  expect(line).not.toMatch(/[\r\n\0]/);
});

test('a stack whose first line is not exactly the name and message gives no location at all', () => {
  const error = new Error('short');
  error.stack = `Error: something else\n    at /app/packages/core/src/${marker}.ts:1:1`;
  expect(errorLine(error)).toBe('Error');
  const renamed = new Error('');
  renamed.stack = `Error\n    at f (/app/packages/core/src/posts/read.ts:9:1)`;
  expect(errorLine(renamed)).toBe('Error at core/src/posts/read.ts:9');
});

test('a mail refusal keeps its numeric reply and SMTP command, never the reply text', () => {
  // As nodemailer's _formatError builds it: the reply is appended to the message after the stack was taken.
  const refusal = (reply: string) => {
    const error = Object.assign(new Error("Can't send mail - all recipients were rejected"), {
      code: 'EENVELOPE',
      response: reply,
      responseCode: Number(reply.slice(0, 3)),
      command: 'RCPT TO',
    });
    error.message += `: ${reply}`;
    return error;
  };
  const later = errorLine(refusal(`450 4.2.1 <${marker}>: Mailbox busy, try again`));
  const never = errorLine(refusal(`550 5.1.1 <${marker}>: Recipient address rejected`));
  expect(later).toMatch(/^Error EENVELOPE 450 RCPT TO( at \S+)?$/);
  expect(never).toMatch(/^Error EENVELOPE 550 RCPT TO( at \S+)?$/);
  expect(`${later} ${never}`).not.toContain(marker);
  // A status out of range, a fractional one, or a command not on the list is left out.
  expect(errorLine(Object.assign(new Error('x'), { statusCode: 99, command: `RCPT TO ${marker}` }))).toMatch(/^Error at \S+$/);
  expect(errorLine(Object.assign(new Error('x'), { status: 404.5 }))).toMatch(/^Error at \S+$/);
  expect(errorLine(Object.assign(new Error('x'), { status: 503 }))).toMatch(/^Error 503 at \S+$/);
});

test('the line is bounded', () => {
  let error: Error = new Error('x');
  for (let depth = 0; depth < 10; depth++)
    error = Object.assign(new Error('x', { cause: error }), { name: 'A'.repeat(60), code: 'C'.repeat(40) });
  expect(errorLine(error).length).toBeLessThanOrEqual(400);
});
