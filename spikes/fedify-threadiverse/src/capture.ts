// Raw wire captures as JSON Lines under captures/:
//   inbound.jsonl   every POST to one of our inboxes (headers, body, our status)
//   outbound.jsonl  every POST we make (deliveries), with the peer's response
//   fetched.jsonl   every GET we make (actors, objects, WebFinger, NodeInfo)
//   rejected.jsonl  every inbound activity the authorization or origin rules refused
// Importing this module patches globalThis.fetch, so it must be imported first.
// Deliveries do not use fetch (outbox.ts, safe-post.ts) and record themselves.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_DIR } from "./config.ts";

mkdirSync(CAPTURE_DIR, { recursive: true });

type Stream = "inbound" | "outbound" | "fetched" | "rejected";

export function capture(stream: Stream, record: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  appendFileSync(join(CAPTURE_DIR, `${stream}.jsonl`), `${line}\n`);
}

const KEPT_HEADERS = [
  "accept",
  "content-type",
  "date",
  "digest",
  "content-digest",
  "signature",
  "signature-input",
  "host",
  "user-agent",
];

export function pickHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    KEPT_HEADERS.flatMap((name) => {
      const value = headers.get(name);
      return value == null ? [] : [[name, value]];
    }),
  );
}

export function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
  }
}

async function bodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (body == null && input instanceof Request && input.body != null) {
    return await input.clone().text();
  }
  return undefined;
}

const originalFetch = globalThis.fetch;

// Pass the original arguments through untouched (Fedify may attach an undici
// dispatcher for SSRF pinning) and record a copy of what went over the wire.
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const sent = method === "POST" ? await bodyText(input, init) : undefined;
  const stream: Stream = method === "POST" ? "outbound" : "fetched";
  const started = Date.now();
  try {
    const response = await originalFetch(input, init);
    const text = await response.clone().text();
    capture(stream, {
      method,
      url,
      status: response.status,
      ms: Date.now() - started,
      requestHeaders: pickHeaders(headers),
      body: sent === undefined ? undefined : parseMaybeJson(sent),
      response: parseMaybeJson(text),
    });
    return response;
  } catch (error) {
    capture(stream, {
      method,
      url,
      error: String(error),
      requestHeaders: pickHeaders(headers),
      body: sent === undefined ? undefined : parseMaybeJson(sent),
    });
    throw error;
  }
};
