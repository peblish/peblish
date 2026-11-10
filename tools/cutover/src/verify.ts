import { randomUUID } from 'node:crypto';
import { db } from '@peblish/core/db/read';
import { localInstance } from '@peblish/core/db/local-instance';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { follows } from '@peblish/core/db/tables/follows';
import { instances } from '@peblish/core/db/tables/instances';
import { localDocument } from '@peblish/federation/actors/serve';
import { deliverableInboxes } from '@peblish/federation/delivery/followers';
import { isFederationRequest } from '@peblish/federation/http';
import { signDelivery } from '@peblish/federation/signing/sign';
import { parseSignature, signatureVerifies } from '@peblish/federation/signing/verify';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { publicFingerprint } from './archive.ts';
import type { Bundle } from './bundle.ts';

// `verify`: for every imported local actor (and the instance actor), sign an activity with its
// stored private key the way delivery does (signDelivery), verify it the way the inbox does
// (parseSignature, signatureVerifies) against the stored public key, and check the actor
// document federation would serve names that key. With the bundle, also check the stored public
// keys are the ones peers cached. Then list every follow of a local actor with the inbox its
// posts and Undo would go to. Prints ids, URLs and key fingerprints only, never key material.

export type KeyCheck = {
  apId: string;
  kind: string;
  keyId: string;
  fingerprint: string;
  /** The private key is the public key's pair. */
  pair: boolean;
  /** A signed POST verifies against the stored public key. */
  signature: boolean;
  /** localDocument serves the actor at its ap_id with this key. */
  served: boolean;
  /** The web server hands a GET of the ap_id (Accept: activity+json) to federation. */
  routed: boolean;
  /** The stored public key is the bundle's (what peers cached); null without a bundle. */
  matchesBundle: boolean | null;
};

export type FollowTarget = {
  follower: string;
  followee: string;
  state: string;
  local: boolean;
  host: string;
  software: string | null;
  inbox: string | null;
  sharedInbox: string | null;
  /** Delivery would send to the inbox now (not held by a peer gate or dormancy). */
  deliverable: boolean;
};

export type VerifyReport = {
  origin: string;
  keys: KeyCheck[];
  follows: FollowTarget[];
  summary: {
    keys: number;
    keysOk: number;
    follows: number;
    accepted: number;
    pending: number;
    local: number;
    undeliverable: number;
    hosts: number;
  };
};

async function checkKey(
  origin: string,
  actor: { apId: string; kind: string; inboxUrl: string | null },
  key: { keyId: string; publicKeyPem: string; privateKeyPem: string },
  bundleKeys: Map<string, string> | null,
): Promise<KeyCheck> {
  const fingerprint = publicFingerprint(key.publicKeyPem);
  let pair = false;
  try {
    pair = publicFingerprint(key.privateKeyPem) === fingerprint;
  } catch {
    pair = false;
  }
  // A Follow-shaped activity to a made-up inbox: the signature covers the target, so any URL does.
  const inbox = 'https://verify.invalid/inbox';
  const body = JSON.stringify({ id: `${origin}/ap/activity/${randomUUID()}`, type: 'Follow', actor: actor.apId, object: inbox });
  let signature = false;
  try {
    const headers = signDelivery({ keyId: key.keyId, privateKeyPem: key.privateKeyPem }, inbox, body);
    const parsed = parseSignature(new Request(inbox, { method: 'POST', headers, body }), new TextEncoder().encode(body));
    signature = typeof parsed !== 'string' && parsed.keyId === key.keyId && signatureVerifies(parsed, key.publicKeyPem);
  } catch {
    signature = false;
  }
  const path = new URL(actor.apId).pathname;
  const document = await localDocument(db(), origin, path);
  const served =
    document?.status === 200 &&
    document.json.id === actor.apId &&
    typeof document.json.publicKey === 'object' &&
    document.json.publicKey !== null &&
    'id' in document.json.publicKey &&
    document.json.publicKey.id === key.keyId &&
    'publicKeyPem' in document.json.publicKey &&
    typeof document.json.publicKey.publicKeyPem === 'string' &&
    publicFingerprint(document.json.publicKey.publicKeyPem) === fingerprint;
  const routed = isFederationRequest(new Request(actor.apId, { headers: { accept: 'application/activity+json' } }));
  const expected = bundleKeys?.get(actor.apId);
  return {
    apId: actor.apId,
    kind: actor.kind,
    keyId: key.keyId,
    fingerprint: fingerprint.slice(0, 16),
    pair,
    signature,
    served,
    routed,
    matchesBundle: bundleKeys === null ? null : expected === fingerprint,
  };
}

/** Verifies the database DATABASE_URL names. `bundle` is the one imported, already rehosted when the import was a rehearsal. */
export async function verifyImport(bundle: Bundle | null): Promise<VerifyReport> {
  const q = db();
  const { origin } = await localInstance(q);
  const bundleKeys =
    bundle === null
      ? null
      : new Map(
          [bundle.instanceActor, ...bundle.users, ...bundle.communities].map((actor) => [
            actor.apId,
            publicFingerprint(actor.key.publicKeyPem),
          ]),
        );
  const rows = await q
    .select({
      apId: actors.apId,
      kind: actors.kind,
      inboxUrl: actors.inboxUrl,
      keyId: actorKeys.keyId,
      publicKeyPem: actorKeys.publicKeyPem,
      privateKeyPem: actorKeys.privateKeyPem,
    })
    .from(actors)
    .innerJoin(actorKeys, and(eq(actorKeys.actorId, actors.id), eq(actorKeys.algorithm, 'rsa')))
    .where(and(eq(actors.local, true), or(isNotNull(actors.importedAt), eq(actors.kind, 'Application'))))
    .orderBy(actors.kind, actors.apId);
  const keys: KeyCheck[] = [];
  for (const row of rows) {
    if (!row.privateKeyPem) continue;
    keys.push(
      await checkKey(origin, row, { keyId: row.keyId, publicKeyPem: row.publicKeyPem, privateKeyPem: row.privateKeyPem }, bundleKeys),
    );
  }

  const follower = alias(actors, 'follower');
  const followee = alias(actors, 'followee');
  const targets = await q
    .select({
      follower: follower.apId,
      followee: followee.apId,
      state: follows.state,
      local: followee.local,
      host: instances.domain,
      software: instances.software,
      inbox: followee.inboxUrl,
      sharedInbox: followee.sharedInboxUrl,
    })
    .from(follows)
    .innerJoin(follower, eq(follower.id, follows.followerId))
    .innerJoin(followee, eq(followee.id, follows.followeeId))
    .innerJoin(instances, eq(instances.id, followee.instanceId))
    .where(eq(follower.local, true))
    .orderBy(follower.apId, instances.domain, followee.apId);
  const followTargets: FollowTarget[] = [];
  for (const row of targets) {
    const deliverable = row.local || (row.inbox !== null && (await deliverableInboxes(q, [row.inbox])).length === 1);
    followTargets.push({ ...row, deliverable });
  }
  const remote = followTargets.filter((row) => !row.local);
  return {
    origin,
    keys,
    follows: followTargets,
    summary: {
      keys: keys.length,
      keysOk: keys.filter((key) => key.pair && key.signature && key.served && key.matchesBundle !== false).length,
      follows: followTargets.length,
      accepted: followTargets.filter((row) => row.state === 'accepted').length,
      pending: followTargets.filter((row) => row.state === 'pending').length,
      local: followTargets.length - remote.length,
      undeliverable: remote.filter((row) => !row.deliverable).length,
      hosts: new Set(remote.map((row) => row.host)).size,
    },
  };
}
