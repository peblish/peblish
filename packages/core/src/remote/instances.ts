import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { canonicalOrigin } from '../config.ts';
import { instances } from '../db/tables/instances.ts';
import type { WriteTx } from '../db/write.ts';
import { defineMutation } from '../tx/mutation.ts';

// Owned by lane FED-A, inherited by REM. The peers this server knows: one row per host,
// created the first time a document names it, with the software its NodeInfo reports.

/**
 * The instance row for the origin of `url`, created when it is new. Two writers racing for a
 * new host both end up with the one row. The host must not be this server's own: an actor
 * document claiming one of our ids is refused here, before anything is stored under it.
 */
export async function ensureInstance(db: WriteTx, url: string): Promise<{ id: Uuid; domain: string; origin: string }> {
  const origin = canonicalOrigin(new URL(url).origin);
  const domain = new URL(origin).host;
  await db.insert(instances).values({ domain, origin, local: false }).onConflictDoNothing();
  const [row] = await db
    .select({ id: instances.id, domain: instances.domain, origin: instances.origin, local: instances.local })
    .from(instances)
    .where(eq(instances.domain, domain));
  if (!row) throw new Error(`instance ${domain} vanished`);
  if (row.local) throw new RangeError(`${url} is on this server, not a peer`);
  return row;
}

export type InstanceSoftware = { software: string | null; version: string | null };

/**
 * Records the software and version a peer's NodeInfo names, and when it was checked
 * (instances.updated_at, which the client reads to refresh after a day). Emits
 * instance.updated only when the software or version changed or the instance is new.
 */
export const storeInstanceSoftware = defineMutation({
  action: 'remote.instance_store',
  emits: ['instance.updated'],
  async run(t, grant, input: InstanceSoftware) {
    const { id, domain } = await ensureInstance(t.db, grant.subject.origin);
    const [before] = await t.db
      .select({ software: instances.software, softwareVersion: instances.softwareVersion })
      .from(instances)
      .where(eq(instances.id, id))
      .for('no key update');
    const software = input.software?.toLowerCase() ?? null;
    await t.db.update(instances).set({ software, softwareVersion: input.version, updatedAt: new Date() }).where(eq(instances.id, id));
    const changed = before?.software !== software || before?.softwareVersion !== input.version;
    if (changed) {
      await t.emit({ type: 'instance.updated', v: 1, instanceId: id, domain, software, softwareVersion: input.version });
    }
    return { instanceId: id, changed };
  },
});

export { isDormant } from './dormant.ts';
