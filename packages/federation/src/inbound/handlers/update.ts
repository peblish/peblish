import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { checkRemoteActor, storeRemoteActor } from '@peblish/core/remote/actors';
import { eq } from 'drizzle-orm';
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
 */
async function prepareActor(ctx: InboundContext, record: ActorRecord): Promise<Prepared> {
  const own = record.apId === ctx.activity.actorApId;
  const byCommunity = ctx.announce?.community.apId === record.apId;
  if (!own && !byCommunity) throw skip('actor.update_unauthorized', record.apId);
  const [held] = await db().select({ local: actors.local }).from(actors).where(eq(actors.apId, record.apId));
  if (!held) throw skip('actor.unknown', record.apId);
  if (held.local) throw skip('actor.update_unauthorized', record.apId);
  if (checkRemoteActor(record) !== null) throw skip('object.origin_mismatch', record.apId);
  const grant = await importGrant('remote.actor_store', { apId: record.apId });
  return prepared(ctx, async (t) => {
    await storeRemoteActor.within(t, grant, record);
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
