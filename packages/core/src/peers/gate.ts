import type { Uuid } from '@peblish/schema/ids';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { instances } from '../db/tables/instances.ts';
import { hostAndParents } from './domains.ts';
import { peerControls } from './tables.ts';

// What this server does about a peer (lane MODF, M18). Four independent controls:
//
// - Quarantine (every peer's default) and purge touch media only: the proxy answers 404 and pages
//   show text, not images, until an admin approves the peer.
// - Inbox pause touches intake only: the inbox answers 503 and the peer retries later.
// - Block does all of that, plus 403 at intake, no delivery to the peer, and no posts of its
//   people or communities in feeds.
//
// No authz policy reads peer_controls, so these reads take no locks. A peer with no row is new.

/** What the inbox does with an activity its signer sent: take it, ask the peer to retry later (503), or refuse it (403). */
export type Intake = 'accept' | 'paused' | 'blocked';

const hostOf = (apId: string) => URL.parse(apId)?.host ?? null;

/** The controls of the peer that hosts `apId`; null when it is unknown or this server's own. */
async function controlsOf(q: Queryable, apId: string) {
  const host = hostOf(apId);
  if (host === null) return null;
  const [row] = await q
    .select({ blocked: peerControls.blocked, inboxPaused: peerControls.inboxPaused })
    .from(peerControls)
    .innerJoin(instances, eq(instances.id, peerControls.instanceId))
    .where(and(eq(instances.domain, host), eq(instances.local, false)));
  return row ?? null;
}

/** The intake rule for the instance of the actor whose key signed the request. */
export async function intakeFor(q: Queryable, signerApId: string): Promise<Intake> {
  const controls = await controlsOf(q, signerApId);
  if (controls?.blocked) return 'blocked';
  return controls?.inboxPaused ? 'paused' : 'accept';
}

/** Whether the actor's instance is blocked. */
export async function instanceBlocked(q: Queryable, actorApId: string): Promise<boolean> {
  return (await controlsOf(q, actorApId))?.blocked === true;
}

/** Whether deliveries to this instance are held back (a blocked peer). */
export async function deliveryBlocked(instanceId: Uuid, q: Queryable = db()): Promise<boolean> {
  const [row] = await q.select({ blocked: peerControls.blocked }).from(peerControls).where(eq(peerControls.instanceId, instanceId));
  return row?.blocked === true;
}

/**
 * Whether media from this host may reach viewers through the proxy. A host at or under a known
 * peer's domain needs the most specific such peer to be approved and not blocked; a host that
 * belongs to no known peer (a link preview's image on a plain website) passes, as does anything
 * on this server's own domain.
 */
export async function mediaAllowed(host: string, q: Queryable = db()): Promise<boolean> {
  const rows = await q
    .select({ domain: instances.domain, local: instances.local, media: peerControls.media, blocked: peerControls.blocked })
    .from(instances)
    .leftJoin(peerControls, eq(peerControls.instanceId, instances.id))
    .where(inArray(instances.domain, hostAndParents(host.toLowerCase())));
  const closest = rows.toSorted((a, b) => b.domain.length - a.domain.length)[0];
  if (!closest || closest.local) return true;
  return closest.media === 'approved' && closest.blocked !== true;
}

/**
 * The domains whose media is denied (a peer is not approved, or is blocked), for renderers that
 * resolve many image URLs at once: a host at or under one of them is treated like remote media
 * switched off. The local instance is never listed.
 */
export async function deniedMediaDomains(q: Queryable = db()): Promise<string[]> {
  const rows = await q
    .select({ domain: instances.domain })
    .from(instances)
    .leftJoin(peerControls, eq(peerControls.instanceId, instances.id))
    .where(
      and(
        eq(instances.local, false),
        or(sql`${peerControls.instanceId} is null`, sql`${peerControls.media} <> 'approved'`, eq(peerControls.blocked, true)),
      ),
    );
  return rows.map((row) => row.domain);
}
