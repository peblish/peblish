import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, expect, test } from 'vitest';
import { crossCheckKeyFiles } from './archive.ts';
import { readBundle } from './bundle.ts';
import { readLedgerExport } from './drill.ts';
import { CutoverError, describe } from './errors.ts';
import { testBundle } from './test-bundle.ts';

// A damaged bundle, key file or ledger export must not print what it holds: the stand-ins
// below are what an excerpt would show (an address, the start of a private key).
const email = 'person@example.org';
const key = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
const dir = mkdtempSync(join(tmpdir(), 'cutover-errors-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
};

/** The message the CLI would print for whatever `run` throws. */
function printed(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return describe(error);
  }
  throw new Error('expected a failure');
}

test('bad JSON in the bundle, a key file or a ledger export is named with a position, never quoted', async () => {
  // V8 quotes the text around an unexpected token: Unexpected token 'M', ..."eKeyPem": MIIEvQIBAD"... is not valid JSON.
  const broken = `{"email": "${email}", "privateKeyPem": ${key}}`;
  expect(() => JSON.parse(broken)).toThrow(key.slice(0, 10));
  const bundle = printed(() => readBundle(file('bundle.json', broken)));
  expect(bundle).toBe('the bundle is not valid JSON');
  const ledger = printed(() => readLedgerExport(file('ledger.json', `{"rows": [], "note": ${JSON.stringify(email)}, }`)));
  expect(ledger).toMatch(/^the ledger export is not valid JSON at line 1, column \d+$/);
  const archive = mkdtempSync(join(dir, 'archive-'));
  writeFileSync(join(archive, 'user-keys.json'), broken, { mode: 0o600 });
  const loaded = await testBundle();
  const crossCheck = printed(() => crossCheckKeyFiles(loaded, archive));
  expect(crossCheck).toBe('user-keys.json is not valid JSON');
  for (const message of [bundle, ledger]) expect(message).not.toMatch(new RegExp(`${email}|${key.slice(0, 10)}`));
  expect(crossCheck).not.toMatch(new RegExp(`${email}|${key}`));
});

test('a bundle or key file of the wrong shape names the paths, never the values found there', async () => {
  const bundle = await testBundle();
  const wrong = {
    ...bundle,
    users: bundle.users.map((user, i) => (i === 0 ? { ...user, role: user.key.privateKeyPem, emailVerified: email } : user)),
  };
  const message = printed(() => readBundle(file('wrong.json', JSON.stringify(wrong))));
  expect(message).toMatch(/^the bundle does not match its format: .*users\[0\]\.role has the wrong type or value/);
  expect(message).toMatch(/users\[0\]\.emailVerified has the wrong type or value/);
  expect(message).not.toMatch(/PRIVATE KEY|person@example\.org/);

  const archive = mkdtempSync(join(dir, 'archive-'));
  writeFileSync(join(archive, 'user-keys.json'), JSON.stringify([{ user_name: 'Andrew', public_key: 1, private_key: key }]), {
    mode: 0o600,
  });
  const keyFile = printed(() => crossCheckKeyFiles(bundle, archive));
  expect(keyFile).toBe('user-keys.json does not match its format: [0].public_key must be a string');
});

test('the CLI prints the tool’s own messages, and only codes and names of any other failure', async () => {
  expect(describe(new CutoverError('--bundle is required'))).toBe('--bundle is required');
  expect(describe(new Error(`could not use ${email}`))).toBe('Error; its message is withheld (it can quote values)');
  // A real Postgres error, whose message quotes the value.
  const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => undefined });
  try {
    const failure = await sql`select ${email}::uuid`.catch((error: unknown) => error);
    expect(String((failure as Error).message)).toContain(email);
    expect(describe(failure)).toBe('database error 22P02; its message is withheld (it can quote values)');
  } finally {
    await sql.end({ timeout: 5 });
  }
  // A Node system error keeps its code, call and path (the operator's own file name).
  const exists = file('exists.json', '{}');
  const system = printed(() => writeFileSync(exists, '', { flag: 'wx' }));
  expect(system).toBe(`EEXIST open ${exists}`);
});
