// The inbound seam: lane FED-A's http.ts routes every inbox POST here, and lane FED-B
// replaces the body with the inbound pipeline (verify, dedupe, apply, enqueue).

/** Seconds a peer should wait before retrying while the inbox is not live. */
const retryAfterSeconds = 300;

/**
 * Answers one inbox POST. Until the pipeline lands the inbox is not live, so it answers 503
 * with Retry-After, and peers keep the activity and retry it later. That is the one
 * maintenance answer an inbox may give: never 410 (peers read it as the actor gone), 418 or another 5xx.
 */
export async function receiveInbound(_request: Request): Promise<Response> {
  return new Response(null, { status: 503, headers: { 'Retry-After': String(retryAfterSeconds) } });
}
