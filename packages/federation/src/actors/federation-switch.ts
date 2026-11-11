import { readSetting } from '@peblish/core/settings/read';

// The federation switch. The site setting `delivery.enabled` (the key kept from when it paused
// delivery only) is the one switch for every request this server makes to another on its own:
// with it off no process sends or fetches anything.
//
// - Delivery claims nothing (delivery/run.ts), dormancy probes included, since a probe is a delivery.
//   A row already claimed reads the switch again immediately before its POST, and goes back to
//   pending unsent, its attempt given back, when it is off.
// - The jobs that fetch do not start a run: backfill, the moderators mirror, missing objects and
//   the recheck of held objects.
// - Every other read of a peer's document (an actor, a signing key, NodeInfo, WebFinger, an
//   object, a collection) throws FederationPaused before a request is made (fetchJson in
//   actors/document.ts, the one place they are read, once the request's headers and signature are
//   ready), before each redirect hop too. A fetcher that waits before it forwards a request reads
//   the switch again after its wait: a host's politeness queue (remote-fetch/polite.ts), the inbound
//   pipeline's lease renewal (inbound/pipeline.ts), the held-signer lookup of an inbox POST
//   (inbound/receive.ts) and a search's block check (resolve/limit.ts). FederationPaused is not a FetchFailure, so
//   nothing records it as the peer's failure: the inbox answers 503 with Retry-After
//   (inbound/receive.ts), the inbound pipeline puts the row back in line with its attempt given
//   back (inbound/pipeline.ts), a NodeInfo check records nothing (nodeinfo/client.ts), and a
//   search answers `resolve.paused` (resolve/web.ts).

/** Thrown instead of a request to another server while the federation switch is off. */
export class FederationPaused extends Error {
  override readonly name = 'FederationPaused';
  constructor() {
    super('federation is paused here (delivery.enabled is off): no request goes out');
  }
}

/** Whether this server may send or fetch anything from another server. */
export const federationOn = (): Promise<boolean> => readSetting('delivery.enabled');

/** Throws FederationPaused while the switch is off. */
export async function assertFederationOn(): Promise<void> {
  if (!(await federationOn())) throw new FederationPaused();
}
