import { eq } from 'drizzle-orm';
import { instances } from './tables/instances.ts';
import type { Writer } from './write.ts';

/** Creates the local instance row for `origin` once; refuses to change the domain later. */
export async function ensureLocalInstance(db: Writer, origin: string): Promise<void> {
  const domain = new URL(origin).host.toLowerCase();
  await db.insert(instances).values({ domain, local: true }).onConflictDoNothing();
  const [local] = await db.select({ domain: instances.domain }).from(instances).where(eq(instances.local, true));
  if (local?.domain !== domain) throw new Error(`the local instance is ${local?.domain}; PUBLIC_ORIGIN says ${domain}`);
}
