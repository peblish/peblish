/** A request handler in the shape TanStack Start's server entry takes. */
export type Fetch<O> = (request: Request, opts?: O) => Promise<Response> | Response;

/** A copy of `response` (body streamed through) whose headers can be changed. */
export const editable = (response: Response) => new Response(response.body, response);
