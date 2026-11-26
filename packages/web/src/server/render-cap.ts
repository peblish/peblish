import { createSlots } from '@peblish/core/media/slots';
import { negotiateLocale, type SupportedLocale } from '../i18n/negotiate.ts';
import type { Fetch } from './fetch.ts';

/**
 * How many signed-out page renders run at once (`limit`), how many more wait their turn in
 * order (`queue`), and how long one may wait (`waitMs`) before it is answered 503.
 */
export type RenderCap = { limit: number; queue: number; waitMs: number };

/**
 * Six renders at once, each holding one or two of the read pool's 10 connections at a time
 * (DATABASE_POOL_MAX), leave room for signed-in readers and federation, and keep the event loop
 * free for the inbox: past a few renders at once a page only gets slower, not more pages done. An idle render takes about
 * 0.2 to 0.4 s, so six drain roughly 15 to 30 a second, against about one a second on a normal
 * day. The queue is what six drain within the wait.
 */
export const DEFAULT_RENDER_CAP: RenderCap = { limit: 6, queue: 24, waitMs: 4000 };

/** Seconds a refused reader is told to wait before trying again. */
export const RETRY_AFTER_SECONDS = 5;

/**
 * PEBLISH_RENDER_CAP (deploy/README.md): unset for the default, `off` for no cap, `<limit>` (the
 * queue then four times the limit) or `<limit>,<queue>`. Anything else is refused at startup.
 */
export function renderCapSetting(value: string | undefined): RenderCap | null {
  const setting = value?.trim() ?? '';
  if (setting === '') return DEFAULT_RENDER_CAP;
  if (setting === 'off') return null;
  const match = /^(\d{1,4})(?:\s*,\s*(\d{1,5}))?$/.exec(setting);
  const limit = Number(match?.[1]);
  if (!match || limit < 1) throw new Error('PEBLISH_RENDER_CAP: expected off, <limit> or <limit>,<queue>');
  return { ...DEFAULT_RENDER_CAP, limit, queue: match[2] === undefined ? limit * 4 : Number(match[2]) };
}

/**
 * Better Auth's session cookie, named from core/identity/auth.ts's cookiePrefix (`peblish`):
 * with the __Secure- prefix on an https origin, without it on plain http (development).
 */
const sessionCookies = new Set(['peblish.session_token', '__Secure-peblish.session_token']);

/** Whether the Cookie header carries a session cookie with a value. Not whether the session is valid: that needs the database. */
export function hasSessionCookie(header: string | null): boolean {
  return (header ?? '').split(';').some((pair) => {
    const eq = pair.indexOf('=');
    return eq > 0 && sessionCookies.has(pair.slice(0, eq).trim()) && pair.slice(eq + 1).trim() !== '';
  });
}

/**
 * Paths that never render a page: server functions (TanStack Start's /_serverFn/<id>, whose
 * callers already hold a page), the liveness and readiness probes, and the two media routes
 * (routes/media/$id.ts and the image proxy, which has its own bound in core/media/proxy.ts),
 * exactly: any other path below /media renders the not-found page. Built and public files never
 * get here: Nitro's static handler answers them before the server entry, and a missing one is
 * the not-found page, so it is counted.
 */
const ungatedPaths = [/^\/_serverFn\//, /^\/(healthz|readyz)$/, /^\/media\/[^/]+$/, /^\/media\/proxy\/[^/]+\/[^/]+$/];

/** Whether a request reaching the UI is a signed-out page render, the kind the cap counts. */
export function isSignedOutPageRender(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (hasSessionCookie(request.headers.get('cookie'))) return false;
  const { pathname } = new URL(request.url);
  return !ungatedPaths.some((path) => path.test(pathname));
}

const busy: Record<SupportedLocale, { title: string; text: string }> = {
  'en-US': { title: 'Busy', text: 'The server is busy right now. Try again in a few seconds.' },
  'de-DE': { title: 'Ausgelastet', text: 'Der Server ist gerade ausgelastet. Versuch es in ein paar Sekunden noch einmal.' },
};

/** The refusal: a tiny page in the reader's language, built without the database. */
export function busyResponse(request: Request): Response {
  const locale = negotiateLocale(request.headers.get('accept-language'));
  const { title, text } = busy[locale];
  const page = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>${title}</title><p>${text}</p></html>\n`;
  return new Response(request.method === 'HEAD' ? null : page, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(RETRY_AFTER_SECONDS) },
  });
}

/** Why a render was refused: every queue place was taken, or it waited past `waitMs`. */
export type Refusal = 'full' | 'waited';

/**
 * Counts refusals and logs them at most once a minute: a count per first path segment (`u`,
 * `c`; anything that is not a plain word is "other"), never an address or a full path. The
 * timer starts at the first refusal and does not keep the process alive.
 */
export function refusalLog(log: (line: string) => void = console.warn, everyMs = 60_000) {
  let counts = new Map<string, number>();
  let reasons = { full: 0, waited: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    const total = reasons.full + reasons.waited;
    const bySegment = [...counts].map(([segment, count]) => `${segment} ${count}`).join(', ');
    log(
      `render cap: refused ${total} signed-out page renders in the last minute (queue full ${reasons.full}, waited too long ${reasons.waited}; ${bySegment})`,
    );
    counts = new Map();
    reasons = { full: 0, waited: 0 };
    timer = undefined;
  };
  return (pathname: string, reason: Refusal) => {
    const segment = pathname === '/' ? 'root' : (/^\/([a-z]{1,20})(?:\/|$)/.exec(pathname)?.[1] ?? 'other');
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
    reasons[reason]++;
    if (!timer) {
      timer = setTimeout(flush, everyMs);
      timer.unref?.();
    }
  };
}

/**
 * The response with its body passed through, calling `done` once the body has been read to its
 * end, cancelled (the server runtime cancels it when the client leaves) or has failed; at once
 * when there is no body. When `gone` has fired already (the client left during the render), the
 * body is cancelled and an empty 499 stands in for it; when it fires later, the body is cancelled
 * too, as a backstop. The headers are read now, as editable() does.
 */
export function onBodySettled(response: Response, done: () => void, gone?: AbortSignal): Response {
  if (!response.body) {
    done();
    return response;
  }
  if (gone?.aborted) {
    // Nobody is left to read it, and a cancelled body cannot be passed on: answer as
    // withClientAborts does.
    response.body.cancel(gone.reason).catch(() => {});
    done();
    return new Response(null, { status: 499, statusText: 'Client Closed Request' });
  }
  const reader = response.body.getReader();
  const leave = () => {
    reader.cancel(gone?.reason).catch(() => {});
    settle();
  };
  const settle = () => {
    gone?.removeEventListener('abort', leave);
    done();
  };
  gone?.addEventListener('abort', leave, { once: true });
  const body = new ReadableStream({
    start(controller) {
      // A source that fails while nothing is reading (a chunk is buffered and the client, still
      // connected, has stopped reading) is seen here, not in pull(). Erroring an already closed
      // or errored stream does nothing.
      reader.closed.catch((error: unknown) => {
        settle();
        controller.error(error);
      });
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          settle();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
}

/**
 * The request as the render sees it: the same method, address and headers, with a signal that
 * never fires. TanStack Start races its work against the request's signal and rejects at once
 * when the client leaves, while the route's loaders run on to their end; the slot must stay
 * taken until they have. The connection's address is carried over, since Start's getRequestIP
 * reads it from the request object.
 */
export function withoutClientSignal(request: Request): Request {
  const render = new Request(request.url, { method: request.method, headers: request.headers });
  if ('ip' in request && typeof request.ip === 'string') Object.defineProperty(render, 'ip', { value: request.ip });
  return render;
}

const settingCap = renderCapSetting(process.env.PEBLISH_RENDER_CAP);

/**
 * Bounds the signed-out page renders web runs at once (src/server.ts puts it inside
 * withFederation, so federation's own answers and inbox POSTs never meet it). A render takes a
 * slot before the route's loaders start and holds it until the handler has settled (a client
 * that leaves does not cut it short: the render gets a request whose signal never fires), then
 * until the streamed body has ended or been cancelled. A reader who finds the queue full, or
 * waits past `waitMs`, gets a 503 with Retry-After; one who leaves while waiting gives the place
 * up. Signed-in readers, server functions, the probes and media are never counted.
 */
export function withRenderCap<O>(next: Fetch<O>, cap: RenderCap | null = settingCap, refused = refusalLog()) {
  if (!cap) return next;
  const slots = createSlots(cap.limit, cap.queue);
  return async (request: Request, opts?: O): Promise<Response> => {
    if (!isSignedOutPageRender(request)) return next(request, opts);
    const timeout = AbortSignal.timeout(cap.waitMs);
    const release = await slots.acquire(AbortSignal.any([request.signal, timeout]));
    if (!release) {
      if (request.signal.aborted) return new Response(null, { status: 499, statusText: 'Client Closed Request' });
      refused(new URL(request.url).pathname, timeout.aborted ? 'waited' : 'full');
      return busyResponse(request);
    }
    let held = true;
    const done = () => {
      if (held) release();
      held = false;
    };
    let response: Response;
    try {
      response = await next(withoutClientSignal(request), opts);
    } catch (error) {
      done();
      throw error;
    }
    return onBodySettled(response, done, request.signal);
  };
}
