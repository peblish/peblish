import { db, type Queryable } from '@peblish/core/db/read';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { checkRemoteActor, storeRemoteActor } from '@peblish/core/remote/actors';
import type { Tx } from '@peblish/core/tx/tx';
import { asc, eq } from 'drizzle-orm';
import { importGrant } from '../../actors/grants.ts';
import type { ActorRecord } from '../../mapping/records.ts';
import { prepared, type InboundContext, type InboundHandler, type Prepared } from '../handler.ts';
import { skip } from '../reasons.ts';
import { prepareContent } from './_content.ts';

/**
 * A profile or community edit. Only an actor we already hold is updated, and only by itself or
 * by its own community announcing the change (Lemmy announces a moderator's Update(Group));
 * the embedded document goes through the same origin checks and the same store as a fetched
 * one. The store keeps `summary` as the peer's raw HTML (nothing here or there sanitises it,
 * and this must not either: readCommunity sanitises on read, and doing it at store would run
 * the media-proxy rewrite twice), so no code of this lane renders or forwards it.
 *
 * Only an actor's own Update says which key it signs with. An edit someone else sent (a
 * moderator's Update(Group), relayed by the community's Announce) keeps the stored key: a
 * document written on another server must not change the key a community is verified by, and a
 * key rotated while the edit is applied must not be rolled back by it.
 */
async function storedKey(q: Queryable, actorId: string, apId: string): Promise<ActorRecord['publicKey']> {
  const [key] = await q
    .select({ keyId: actorKeys.keyId, pem: actorKeys.publicKeyPem })
    .from(actorKeys)
    .where(eq(actorKeys.actorId, actorId))
    .orderBy(asc(actorKeys.createdAt))
    .limit(1);
  return key ? { keyId: key.keyId, ownerApId: apId, pem: key.pem } : null;
}

/**
 * An edit that is not the actor's own: the profile fields only, `input.keys` being false.
 *
 * integration: lane REM's profile-only store is `storeRemoteActor.within(t, grant, { ...record,
 * keys: false })`, which never reads or writes actor_keys. Replace the call to this function with
 * that and delete it. Until then the actor's row is locked before the held key is read and
 * written back with the profile: a rotation that committed first is read as it is, and one still
 * open makes this wait for it, so it is never overwritten with the key read before.
 */
async function storeProfileOnly(t: Tx, grant: Parameters<typeof storeRemoteActor.within>[1], input: ActorRecord & { keys: false }) {
  const { keys: _, ...record } = input;
  const [held] = await t.db.select({ id: actors.id }).from(actors).where(eq(actors.apId, record.apId)).for('update');
  const publicKey = held ? await storedKey(t.db, held.id, record.apId) : null;
  return storeRemoteActor.within(t, grant, { ...record, publicKey });
}

async function prepareActor(ctx: InboundContext, record: ActorRecord): Promise<Prepared> {
  const own = record.apId === ctx.activity.actorApId;
  const byCommunity = ctx.announce?.community.apId === record.apId;
  if (!own && !byCommunity) throw skip('actor.update_unauthorized', record.apId);
  const [held] = await db().select({ id: actors.id, local: actors.local }).from(actors).where(eq(actors.apId, record.apId));
  if (!held) throw skip('actor.unknown', record.apId);
  if (held.local) throw skip('actor.update_unauthorized', record.apId);
  if (checkRemoteActor(record) !== null) throw skip('object.origin_mismatch', record.apId);
  const grant = await importGrant('remote.actor_store', { apId: record.apId });
  return prepared(ctx, async (t) => {
    // An actor that sent a Delete stays deleted: the store changes nothing.
    const stored = own ? await storeRemoteActor.within(t, grant, record) : await storeProfileOnly(t, grant, { ...record, keys: false });
    if (stored.deleted) throw skip('target.deleted', record.apId);
    return { objectApId: record.apId };
  });
}

export const handler: InboundHandler = {
  type: 'Update',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Update') throw new TypeError('the Update handler was given another activity');
    return activity.object.type === 'Actor' ? prepareActor(ctx, activity.object.actor) : prepareContent(ctx, activity.object, 'Update');
  },
};
