import { eq } from 'drizzle-orm';
import { actors } from './tables/actors.ts';
import { instances } from './tables/instances.ts';
import type { Writer } from './write.ts';

/**
 * Creates the local instance row and the instance actor (kind Application, ap_id at the
 * origin's root, named after the host) for `origin` once, and refuses a different domain
 * later. A cutover import runs migrate without PUBLIC_ORIGIN and inserts both from the
 * archive instead, so the imported instance actor keeps its URL and key.
 */
export async function ensureLocalInstance(db: Writer, origin: string): Promise<void> {
  const domain = new URL(origin).host.toLowerCase();
  await db.transaction(async (tx) => {
    await tx.insert(instances).values({ domain, local: true }).onConflictDoNothing();
    const [local] = await tx.select({ id: instances.id, domain: instances.domain }).from(instances).where(eq(instances.local, true));
    if (local?.domain !== domain) throw new Error(`the local instance is ${local?.domain}; PUBLIC_ORIGIN says ${domain}`);
    await tx
      .insert(actors)
      .values({ apId: new URL('/', origin).href, kind: 'Application', local: true, instanceId: local.id, name: domain })
      .onConflictDoNothing();
  });
}
