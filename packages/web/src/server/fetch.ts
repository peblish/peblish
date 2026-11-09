/** A request handler in the shape TanStack Start's server entry takes. */
export type Fetch<O> = (request: Request, opts?: O) => Promise<Response> | Response;

/**
 * A copy of `response` (body streamed through) whose headers can be changed. The status and
 * headers are read now: built from the response itself, the server runtime's copy answered 200
 * for a 404 once a header was added.
 */
export const editable = (response: Response) =>
  new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
