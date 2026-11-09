import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { request } from '@playwright/test';
import { mailedLink } from '../auth/support.ts';

// The data behind the budget's signed-in and token pages: seeded once per run on the lane
// database (seed.ts), then the verification and reset links read from Mailpit as a person
// would. None of this exists against a remote BASE_URL, so those routes are skipped there.

const root = join(import.meta.dirname, '../..');

interface Seeded {
  admin: { name: string; password: string; totpSecret: string };
  inviteCode: string;
  person: { email: string };
}

export interface Fixtures extends Seeded {
  /** /auth/verify?token=... as mailed to the unverified person, for the server under test. */
  verifyPath: string;
  /** /auth/reset?token=... as mailed after a reset request. */
  resetPath: string;
}

let loading: Promise<Fixtures> | undefined;

/** The fixtures, created on first use and shared by every route of the run. */
export function fixtures(baseURL: string): Promise<Fixtures> {
  loading ??= load(baseURL);
  return loading;
}

async function load(baseURL: string): Promise<Fixtures> {
  const seeded = JSON.parse(execFileSync('node', ['e2e/payload/seed.ts'], { cwd: root, encoding: 'utf8' })) as Seeded;
  const verify = await mailedLink(seeded.person.email, baseURL);
  const api = await request.newContext({ baseURL });
  try {
    // The form posts as a browser would: same origin. The answer is the same whether or not the address has an account.
    const asked = await api.post('/auth/reset', { form: { intent: 'request', email: seeded.person.email }, headers: { origin: baseURL } });
    if (!asked.ok()) throw new Error(`the reset request answered ${asked.status()}`);
  } finally {
    await api.dispose();
  }
  const reset = await mailedLink(seeded.person.email, baseURL, 1);
  const path = (link: string) => new URL(link).pathname + new URL(link).search;
  return { ...seeded, verifyPath: path(verify), resetPath: path(reset) };
}
