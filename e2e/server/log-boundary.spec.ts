import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { expect, request, test } from '@playwright/test';
import { boot, freePort, laneDatabase, logLines, stop, type Booted } from './boot.ts';

// The web process's log boundary (packages/web/src/server/log-boundary.ts): whatever logs an error
// while serving a visitor (TanStack Start's own reporters, Better Auth, the database library),
// what the visitor typed never reaches the log, and each entry is one line.

const root = join(import.meta.dirname, '../..');
const marker = 'MARKER-typed-by-a-visitor';

/** Every line the server wrote after starting: none holds the marker, none is a stack's continuation. */
function expectCleanLog(server: Booted) {
  expect(server.output()).not.toContain(marker);
  for (const line of logLines(server)) expect(line).not.toMatch(/^\s/);
}

/** A server function's id in the build (TanStack Start names each by a hash). */
function serverFunctionId(name: string): string {
  const folder = join(root, 'packages/web/.output/server/_ssr');
  for (const file of readdirSync(folder)) {
    const text = readFileSync(join(folder, file), 'utf8');
    const found = new RegExp(`id: "([0-9a-f]{64})",\\s*name: "${name}"`).exec(text);
    if (found?.[1]) return found[1];
  }
  throw new Error(`no server function ${name} in the build`);
}

/** An SMTP server that refuses every recipient, naming the address in its reply as real ones do. */
async function refusingSmtp(): Promise<{ url: string; server: Server }> {
  const server = createServer((socket) => {
    socket.write('220 refuse.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of String(chunk).split('\r\n').filter(Boolean)) {
        if (/^(EHLO|HELO)/i.test(line)) socket.write('250 refuse.test\r\n');
        else if (/^MAIL FROM/i.test(line)) socket.write('250 2.1.0 Ok\r\n');
        else if (/^RCPT TO:<(.*)>/i.test(line))
          socket.write(`550 5.1.1 <${/^RCPT TO:<(.*)>/i.exec(line)?.[1]}>: Recipient address rejected\r\n`);
        else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n');
        else if (/^RSET/i.test(line)) socket.write('250 Ok\r\n');
        else socket.write('502 5.5.2 Error: command not recognized\r\n');
      }
    });
    socket.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return { url: `smtp://127.0.0.1:${address.port}`, server };
}

test.describe('the log boundary', () => {
  test.skip(Boolean(process.env.BASE_URL), 'starts its own servers from packages/web/.output');

  test('a server function call with a payload that is not JSON: TanStack Start reports it without the payload, and answers JSON', async () => {
    const server = await boot(laneDatabase());
    try {
      const id = serverFunctionId('getRootData');
      const response = await fetch(
        `${server.origin}/_serverFn/${id}?payload=${encodeURIComponent(`${marker}\n    at /app/packages/x.ts:1:1`)}`,
        {
          headers: { 'sec-fetch-site': 'same-origin' },
        },
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      // The answer is JSON for the caller, never HTML that could reflect what it sent.
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect.poll(() => logLines(server).length).toBeGreaterThan(0);
      expectCleanLog(server);
    } finally {
      await stop(server);
    }
  });

  test('a signed-in post whose title the database refuses: the error that escapes to Start is one line without the title', async () => {
    const server = await boot(laneDatabase());
    const world = JSON.parse(execFileSync('node', ['e2e/composer/seed.ts'], { cwd: root, encoding: 'utf8' })) as {
      password: string;
      people: { poster: string };
      communities: { open: { id: string } };
    };
    const client = await request.newContext({ baseURL: server.origin, extraHTTPHeaders: { origin: server.origin } });
    try {
      const signedIn = await client.post('/auth/sign-in', {
        form: { identifier: `@${world.people.poster}`, password: world.password },
        maxRedirects: 0,
      });
      expect(signedIn.status()).toBe(303);
      // The session cookie is __Secure-: the request client keeps it off plain HTTP, so it is sent by hand.
      const cookie = signedIn
        .headersArray()
        .filter((header) => header.name.toLowerCase() === 'set-cookie')
        .map((header) => header.value.split(';')[0])
        .join('; ');
      // A NUL passes the form's own checks; Postgres refuses it, and its error quotes the parameter.
      const posted = await client.post('/submit', {
        headers: { cookie },
        form: {
          community: world.communities.open.id,
          type: 'text',
          title: `x\u0000${marker}\n    at /app/packages/${marker}.ts:1:1`,
          body: '',
        },
        maxRedirects: 0,
      });
      expect(posted.status()).toBe(500);
      // Start's own answer, JSON with no cause in it.
      expect(await posted.text()).not.toContain(marker);
      await expect.poll(() => logLines(server).length).toBeGreaterThan(0);
      expectCleanLog(server);
    } finally {
      await client.dispose();
      await stop(server);
    }
  });

  test('a reset mail the mail server refuses: Better Auth reports the failure in one line, without the address typed', async () => {
    const smtp = await refusingSmtp();
    const name = `markerreset_${Date.now().toString(36)}`;
    execFileSync('node', ['packages/core/src/testing/seed-a.ts', 'e2e-person', name], { cwd: root, encoding: 'utf8' });
    const server = await boot(laneDatabase(), { SMTP_URL: smtp.url });
    const client = await request.newContext({ baseURL: server.origin, extraHTTPHeaders: { origin: server.origin } });
    try {
      const asked = await client.post('/auth/reset', { form: { intent: 'request', email: `${name}@example.test` }, maxRedirects: 0 });
      expect(asked.status()).toBeLessThan(500);
      await expect.poll(() => logLines(server).join('\n'), { timeout: 10_000 }).toContain('Better Auth');
      expect(server.output()).not.toContain(name);
      for (const line of logLines(server)) expect(line).not.toMatch(/^\s/);
      // The line still says what happened: the mail server's permanent refusal at RCPT TO.
      expect(logLines(server).join('\n')).toMatch(/EENVELOPE 550 RCPT TO/);
    } finally {
      await client.dispose();
      await stop(server);
      smtp.server.close();
    }
  });

  test("an ActivityPub request for a person while the database is down: federation's 503 is logged by its endpoint, never the handle asked for", async () => {
    // Nothing listens on this port: every query fails at once, as in an outage.
    const server = await boot(`postgres://peblish:peblish@127.0.0.1:${await freePort()}/peblish`);
    try {
      const response = await fetch(`${server.origin}/u/${marker}`, { headers: { accept: 'application/activity+json' } });
      expect(response.status).toBe(503);
      await expect.poll(() => logLines(server).join('\n')).toContain('federation:');
      expectCleanLog(server);
      expect(logLines(server).join('\n')).toContain('federation: GET document /u/ failed:');
    } finally {
      await stop(server);
    }
  });
});
