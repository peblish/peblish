import { eq } from 'drizzle-orm';
import { canonicalOrigin } from '../config.ts';
import { actors } from './tables/actors.ts';
import { instances } from './tables/instances.ts';
import type { Writer } from './write.ts';

/**
 * Creates the local instance row and the instance actor (kind Application, ap_id at the
 * origin's root, named after the host) for `origin` once, and refuses a different canonical
 * origin later (another host, or the same host under another scheme). A cutover import runs
 * migrate without PUBLIC_ORIGIN and inserts both from the archive instead, so the imported
 * instance actor keeps its URL and key.
 */
export async function ensureLocalInstance(db: Writer, origin: string): Promise<void> {
  const canonical = canonicalOrigin(origin);
  const domain = new URL(canonical).host;
  await db.transaction(async (tx) => {
    await tx.insert(instances).values({ domain, origin: canonical, local: true }).onConflictDoNothing();
    const [local] = await tx.select({ id: instances.id, origin: instances.origin }).from(instances).where(eq(instances.local, true));
    if (local?.origin !== canonical) throw new Error(`the local instance is ${local?.origin}; PUBLIC_ORIGIN says ${canonical}`);
    await tx
      .insert(actors)
      .values({ apId: `${canonical}/`, kind: 'Application', local: true, instanceId: local.id, name: domain })
      .onConflictDoNothing();
  });
}
