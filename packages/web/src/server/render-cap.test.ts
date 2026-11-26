import { describe, expect, test, vi } from 'vitest';
import {
  hasSessionCookie,
  isSignedOutPageRender,
  refusalLog,
  renderCapSetting,
  withoutClientSignal,
  withRenderCap,
  type RenderCap,
} from './render-cap.ts';

const page = (path: string, init: RequestInit = {}) => new Request(`https://feddit.test${path}`, init);
const signedIn = { cookie: 'theme=dark; __Secure-peblish.session_token=abc.def' };

/** A page whose body streams one chunk now and the rest when `finish` is called. */
function streamingPage() {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<!doctype html>'));
      finish = () => controller.close();
      fail = (error) => controller.error(error);
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/html' } }),
    finish: () => finish(),
    fail: (error: Error) => fail(error),
  };
}

/** A UI handler that records each render and answers each with a page still streaming. */
function renders() {
  const pages: ReturnType<typeof streamingPage>[] = [];
  const ui = vi.fn(async () => {
    const next = streamingPage();
    pages.push(next);
    return next.response;
  });
  return { ui, pages };
}

const cap = (overrides: Partial<RenderCap> = {}): RenderCap => ({ limit: 1, queue: 1, waitMs: 1000, ...overrides });
const quiet = () => {};

describe('who the cap counts', () => {
  test('signed-out GET and HEAD page renders, whatever the page', () => {
    for (const path of [
      '/',
      '/u/someone@lemmy.test',
      '/c/news@lemmy.test?sort=top',
      '/auth/login',
      '/no-such-page',
      '/media/a/b/c',
      '/assets/gone.js',
    ]) {
      expect(isSignedOutPageRender(page(path))).toBe(true);
    }
    expect(isSignedOutPageRender(page('/u/someone@lemmy.test', { method: 'HEAD' }))).toBe(true);
  });

  test('never a signed-in reader, another method, a server function, a probe or media', () => {
    expect(isSignedOutPageRender(page('/u/someone@lemmy.test', { headers: signedIn }))).toBe(false);
    expect(isSignedOutPageRender(page('/auth/login', { method: 'POST', body: '' }))).toBe(false);
    for (const path of ['/_serverFn/abc123', '/healthz', '/readyz', '/media/0190', '/media/proxy/sig/target']) {
      expect(isSignedOutPageRender(page(path))).toBe(false);
    }
  });

  test('the session cookie is either name with a value; an emptied one or a look-alike is signed out', () => {
    expect(hasSessionCookie('peblish.session_token=abc')).toBe(true);
    expect(hasSessionCookie('a=1; __Secure-peblish.session_token=abc')).toBe(true);
    expect(hasSessionCookie('peblish.session_token=')).toBe(false);
    expect(hasSessionCookie('xpeblish.session_token=abc; session_token=abc')).toBe(false);
    expect(hasSessionCookie(null)).toBe(false);
  });
});

describe('the setting', () => {
  test('default, off, a limit, or a limit and a queue; anything else is refused', () => {
    expect(renderCapSetting(undefined)).toEqual({ limit: 6, queue: 24, waitMs: 4000 });
    expect(renderCapSetting('off')).toBeNull();
    expect(renderCapSetting('3')).toEqual({ limit: 3, queue: 12, waitMs: 4000 });
    expect(renderCapSetting('8, 40')).toEqual({ limit: 8, queue: 40, waitMs: 4000 });
    for (const bad of ['0', '-1', 'six', '6,', '6;24']) expect(() => renderCapSetting(bad)).toThrow(/PEBLISH_RENDER_CAP/);
  });

  test('off leaves the handler as it was', () => {
    const ui = async () => new Response('ok');
    expect(withRenderCap(ui, null)).toBe(ui);
  });
});

describe('the limit and the queue', () => {
  test('past the limit a render waits its turn; past the queue it is refused at once with 503', async () => {
    const { ui, pages } = renders();
    const fetch = withRenderCap(ui, cap(), quiet);
    const first = await fetch(page('/u/a@x.test'));
    const second = fetch(page('/u/b@x.test'));
    const third = await fetch(page('/u/c@x.test'));
    expect(third.status).toBe(503);
    expect(ui).toHaveBeenCalledTimes(1);
    pages[0]!.finish();
    await first.text();
    await second;
    expect(ui).toHaveBeenCalledTimes(2);
  });

  test('a render that waits past the limit is refused with Retry-After and no-store, in the reader’s language', async () => {
    const { ui } = renders();
    const fetch = withRenderCap(ui, cap({ waitMs: 20 }), quiet);
    await fetch(page('/u/a@x.test'));
    const refused = await fetch(page('/c/b@x.test', { headers: { 'accept-language': 'de-DE,de;q=0.9' } }));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(refused.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await refused.text()).toContain('<html lang="de-DE">');
    const head = await fetch(page('/c/b@x.test', { method: 'HEAD' }));
    expect(head.status).toBe(503);
    expect(head.body).toBeNull();
  });

  test('signed-in readers and server functions pass a full cap', async () => {
    const { ui } = renders();
    const fetch = withRenderCap(ui, cap({ queue: 0 }), quiet);
    await fetch(page('/u/a@x.test'));
    expect((await fetch(page('/u/b@x.test'))).status).toBe(503);
    expect((await fetch(page('/u/b@x.test', { headers: signedIn }))).status).toBe(200);
    expect((await fetch(page('/_serverFn/abc'))).status).toBe(200);
  });
});

describe('the slot is held for the whole render', () => {
  test('until the streamed body has ended, not just until the headers', async () => {
    const { ui, pages } = renders();
    const fetch = withRenderCap(ui, cap({ queue: 0 }), quiet);
    const first = await fetch(page('/u/a@x.test'));
    const reader = first.body!.getReader();
    await reader.read();
    expect((await fetch(page('/u/b@x.test'))).status).toBe(503);
    pages[0]!.finish();
    expect((await reader.read()).done).toBe(true);
    expect((await fetch(page('/u/b@x.test'))).status).toBe(200);
  });

  test('until the body is cancelled, as the runtime does when the client leaves mid-page', async () => {
    const { ui } = renders();
    const fetch = withRenderCap(ui, cap({ queue: 0 }), quiet);
    const first = await fetch(page('/u/a@x.test'));
    await first.body!.cancel();
    expect((await fetch(page('/u/b@x.test'))).status).toBe(200);
  });

  test('until a failing body has failed', async () => {
    const { ui, pages } = renders();
    const fetch = withRenderCap(ui, cap({ queue: 0 }), quiet);
    const first = await fetch(page('/u/a@x.test'));
    pages[0]!.fail(new Error('render failed'));
    await expect(first.text()).rejects.toThrow('render failed');
    expect((await fetch(page('/u/b@x.test'))).status).toBe(200);
  });

  test('a body that fails while nobody reads it frees the slot', async () => {
    const { ui, pages } = renders();
    const fetch = withRenderCap(ui, cap({ queue: 0 }), quiet);
    const first = await fetch(page('/u/a@x.test'));
    expect((await fetch(page('/u/b@x.test'))).status).toBe(503);
    pages[0]!.fail(new Error('stream lifetime over'));
    await vi.waitFor(async () => expect((await fetch(page('/u/b@x.test'))).status).toBe(200));
    await expect(first.text()).rejects.toThrow('stream lifetime over');
  });

  test('a render that throws gives its slot back', async () => {
    let calls = 0;
    const fetch = withRenderCap(
      async () => {
        calls++;
        if (calls === 1) throw new Error('loader failed');
        return new Response(null, { status: 307, headers: { location: '/c/news@x.test' } });
      },
      cap({ queue: 0 }),
      quiet,
    );
    await expect(fetch(page('/u/a@x.test'))).rejects.toThrow('loader failed');
    expect((await fetch(page('/c/news@x.test?layout=list'))).status).toBe(307);
    expect((await fetch(page('/c/news@x.test?layout=list'))).status).toBe(307);
  });

  test('a client that leaves while waiting frees its queue place', async () => {
    const { ui, pages } = renders();
    const fetch = withRenderCap(ui, cap({ queue: 1 }), quiet);
    const first = await fetch(page('/u/a@x.test'));
    const gone = new AbortController();
    const waiting = fetch(page('/u/b@x.test', { signal: gone.signal }));
    expect((await fetch(page('/u/c@x.test'))).status).toBe(503);
    gone.abort();
    expect((await waiting).status).toBe(499);
    // The place is free again: the next reader waits in it and gets the slot when the first page ends.
    const next = fetch(page('/u/d@x.test'));
    pages[0]!.finish();
    await first.text();
    expect((await next).status).toBe(200);
    expect(ui).toHaveBeenCalledTimes(2);
  });

  test('a client that leaves mid-loader keeps the slot until the loader has finished', async () => {
    let finishLoader!: () => void;
    const loader = new Promise<void>((resolve) => (finishLoader = resolve));
    // As TanStack Start does: its work is raced against the request's signal, while the route's
    // loader runs on to its end whatever the race decides.
    const start = vi.fn(async (request: Request) => {
      const left = new Promise<never>((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
      await Promise.race([loader, left]);
      return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
    });
    const fetch = withRenderCap(start, cap({ queue: 0 }), quiet);
    const gone = new AbortController();
    const abandoned = fetch(page('/c/a@x.test', { signal: gone.signal }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    gone.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await fetch(page('/c/b@x.test'))).status).toBe(503);
    finishLoader();
    // The render ran to its end; nobody is left to read it.
    const answered = await abandoned;
    expect([answered.status, answered.body]).toEqual([499, null]);
    expect((await fetch(page('/c/b@x.test'))).status).toBe(200);
  });

  test('a client that leaves mid-page frees the slot and stops the body', async () => {
    const { ui } = renders();
    const fetch = withRenderCap(ui, cap({ queue: 0 }), quiet);
    const gone = new AbortController();
    const first = await fetch(page('/u/a@x.test', { signal: gone.signal }));
    const reader = first.body!.getReader();
    await reader.read();
    gone.abort();
    expect((await reader.read()).done).toBe(true);
    expect((await fetch(page('/u/b@x.test'))).status).toBe(200);
  });

  test('the render keeps the method, headers and address, but not the client’s signal', () => {
    const gone = new AbortController();
    const request = page('/u/a@x.test', { method: 'HEAD', headers: { 'accept-language': 'de' }, signal: gone.signal });
    Object.defineProperty(request, 'ip', { value: '192.0.2.7' });
    const render = withoutClientSignal(request);
    gone.abort();
    expect(render.signal.aborted).toBe(false);
    expect([render.method, render.url, render.headers.get('accept-language')]).toEqual(['HEAD', request.url, 'de']);
    expect('ip' in render && render.ip).toBe('192.0.2.7');
  });
});

describe('the refusal log', () => {
  test('one line a minute at most: counts by first path segment, no addresses or full paths', () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const record = refusalLog((line) => lines.push(line));
      record('/u/someone@lemmy.test', 'full');
      record('/u/other@lemmy.test', 'waited');
      record('/c/news@lemmy.test', 'full');
      record('/%7Ehidden/path', 'full');
      vi.advanceTimersByTime(59_999);
      expect(lines).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(lines).toEqual([
        'render cap: refused 4 signed-out page renders in the last minute (queue full 3, waited too long 1; u 2, c 1, other 1)',
      ]);
      vi.advanceTimersByTime(120_000);
      expect(lines).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
