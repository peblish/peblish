import type { Fetch } from './fetch.ts';

/**
 * Whether an error that escaped a request's handler means only that the client left before the
 * reply ended (it navigated on, or closed the tab). The server runtime (srvx) aborts the request's
 * signal when the connection closes early, with Node's `Error: aborted` (ECONNRESET) or a bare
 * AbortError as the reason, and whatever was waiting on the signal (a loader, the media proxy's
 * upstream fetch, a form body being read) rejects with it. Both conditions must hold: an error of
 * any other kind (a database error, an upstream failure, the server's own TimeoutError) is a real
 * failure even when the client has also gone, and an AbortError while the client is still there
 * came from the server's own code.
 */
export function clientWentAway(request: Request, error: unknown): boolean {
  if (!request.signal.aborted) return false;
  if (error === request.signal.reason) return true;
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || ('code' in error && error.code === 'ECONNRESET' && error.message === 'aborted');
}

/**
 * The outermost wrapper of the server entry (src/server.ts). TanStack Start logs every error that
 * reaches its own catch with a full stack; a client leaving is a normal end of a request, so it is
 * answered here without a log line. Nobody reads the answer: 499 is the conventional "client
 * closed request" status. Everything else is rethrown to Start's handler, which logs it as before.
 */
export function withClientAborts<O>(next: Fetch<O>) {
  return async (request: Request, opts?: O): Promise<Response> => {
    try {
      return await next(request, opts);
    } catch (error) {
      if (clientWentAway(request, error)) return new Response(null, { status: 499, statusText: 'Client Closed Request' });
      throw error;
    }
  };
}
