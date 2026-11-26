import { describe, expect, test, vi } from 'vitest';
import { serverChain } from './chain.ts';

// The connection's peer, as TanStack Start's getRequestIP gives it inside a request.
vi.mock('@tanstack/react-start/server', async (original) => ({
  ...(await original<typeof import('@tanstack/react-start/server')>()),
  getRequestIP: () => '10.0.0.2',
}));

const origin = 'https://feddit.test';
const json = 'application/activity+json';

/** Federation as it answers here: the inbox and the local actor /u/andrew; any other page is the UI's. */
const federation = async (request: Request) => {
  const { pathname } = new URL(request.url);
  if (pathname === '/inbox') return new Response(null, { status: 202 });
  if (pathname === '/u/andrew') return Response.json({ type: 'Person' });
  return null;
};

describe('the render cap in the server chain', () => {
  test('a full cap refuses signed-out pages only: the inbox, ActivityPub reads and signed-in pages still answer', async () => {
    const rendered: string[] = [];
    // Each page holds its slot: its body never ends during the test.
    const start = vi.fn(async (request: Request) => {
      rendered.push(new URL(request.url).pathname);
      return new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('<!doctype html>')) }), {
        headers: { 'content-type': 'text/html' },
      });
    });
    const fetch = serverChain(start, federation, { limit: 1, queue: 0, waitMs: 1000 });

    expect((await fetch(new Request(`${origin}/u/someone@lemmy.test`))).status).toBe(200);
    const refused = await fetch(new Request(`${origin}/c/news@lemmy.test`));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    // The refusal is an HTML response like any other: it gets the security baseline too.
    expect(refused.headers.get('x-content-type-options')).toBe('nosniff');

    const inbox = await fetch(new Request(`${origin}/inbox`, { method: 'POST', body: '{}', headers: { 'content-type': json } }));
    expect(inbox.status).toBe(202);

    const actor = await fetch(new Request(`${origin}/u/andrew`, { headers: { accept: json } }));
    expect(actor.status).toBe(200);
    expect(await actor.json()).toEqual({ type: 'Person' });

    const signedIn = await fetch(new Request(`${origin}/u/someone@lemmy.test`, { headers: { cookie: 'peblish.session_token=abc.def' } }));
    expect(signedIn.status).toBe(200);
    expect((await fetch(new Request(`${origin}/healthz`))).status).toBe(200);

    expect(rendered).toEqual(['/u/someone@lemmy.test', '/u/someone@lemmy.test', '/healthz']);
  });

  test('a page federation declines is rendered under the cap, still knowing when its client leaves', async () => {
    const start = vi.fn(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    const gone = new AbortController();
    const fetch = serverChain(start, federation, { limit: 0, queue: 1, waitMs: 1000 });
    const waiting = fetch(new Request(`${origin}/u/someone@lemmy.test`, { headers: { accept: json }, signal: gone.signal }));
    gone.abort();
    expect((await waiting).status).toBe(499);
    expect(start).not.toHaveBeenCalled();
  });
});
