import type { Uuid } from '@peblish/schema/ids';
import { db, type Queryable } from '../db/read.ts';

// Owned by lane MODF, which replaces the bodies and keeps the signatures. GW3's stubs answer
// what the server does today (every peer accepted, nothing blocked, all remote media allowed),
// so the intake, delivery and media call sites can be wired before peer controls exist. No
// policy reads peer controls, so these reads take no locks.

/** What the inbox does with an activity its signer sent: take it, ask the peer to retry later (503), or refuse it (403). */
export type Intake = 'accept' | 'paused' | 'blocked';

/** The intake rule for the instance of the actor whose key signed the request. */
export async function intakeFor(_q: Queryable, _signerApId: string): Promise<Intake> {
  return 'accept';
}

/** Whether the actor's instance is blocked. */
export async function instanceBlocked(_q: Queryable, _actorApId: string): Promise<boolean> {
  return false;
}

/** Whether deliveries to this instance are held back (a blocked peer). */
export async function deliveryBlocked(_instanceId: Uuid, _q: Queryable = db()): Promise<boolean> {
  return false;
}

/** Whether media from this host may reach viewers through the proxy. */
export async function mediaAllowed(_host: string, _q: Queryable = db()): Promise<boolean> {
  return true;
}

/** The domains whose media is denied, for renderers that resolve many image URLs at once. */
export async function deniedMediaDomains(_q: Queryable): Promise<string[]> {
  return [];
}
