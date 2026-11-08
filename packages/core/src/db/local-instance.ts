import { eq } from 'drizzle-orm';
import type { Queryable } from './read.ts';
import { instances } from './tables/instances.ts';

/** The row for this server; its domain is the origin every local ap_id is minted under. */
export async function localInstance(q: Queryable): Promise<{ id: string; origin: string }> {
  const [row] = await q.select({ id: instances.id, domain: instances.domain }).from(instances).where(eq(instances.local, true));
  if (!row) throw new Error('no local instance row: run the migrate command with PUBLIC_ORIGIN set');
  return { id: row.id, origin: `https://${row.domain}` };
}
