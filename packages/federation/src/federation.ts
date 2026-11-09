import { localInstance } from '@peblish/core/db/local-instance';
import { db } from '@peblish/core/db/read';

// What federation here knows about itself. Fedify's createFederation is not used: its
// dispatchers serve JSON-LD it compacts (Lemmy's strict parser rejects the result), its router
// takes one actor path (issue 646), its queue loses a message that crashes mid-delivery, and
// its second-signature retry masks the real error (spike RESULT.md). What this package takes
// from Fedify is HTTP signing (signing/sign.ts); everything else is the mapping's documents,
// our own router (http.ts) and our own queue (delivery/). The memory key-value store the plan
// kept for Fedify therefore has nothing to hold.

/** What NodeInfo and the User-Agent say we are. */
export const software = {
  name: 'peblish',
  version: '0.1.0',
  repository: 'https://github.com/peblish/peblish',
} as const;

// The origin never changes once migrate has stored it. On globalThis because the web build can
// hold two copies of this module.
const cache = globalThis as { __peblishOrigin?: Promise<string> };

/** This server's origin, such as https://feddit.com: what every local ap_id is minted under. */
export function localOrigin(): Promise<string> {
  cache.__peblishOrigin ??= localInstance(db())
    .then(({ origin }) => origin)
    .catch((error: unknown) => {
      // A server started before migrate must try again, not cache the failure.
      delete cache.__peblishOrigin;
      throw error;
    });
  return cache.__peblishOrigin;
}

/** The User-Agent of every request we make: software, version and where to find us. */
export async function userAgent(): Promise<string> {
  return `${software.name}/${software.version} (+${await localOrigin()})`;
}
