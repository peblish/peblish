import type { SystemJob, SystemPrincipal } from '@peblish/schema/authz';
import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';

/**
 * The principal for work the instance does as itself (registration, imports, scheduled
 * jobs): the local instance actor, which migrate creates (db/bootstrap.ts).
 */
export async function systemPrincipal(q: Queryable, job: SystemJob): Promise<SystemPrincipal> {
  const [instanceActor] = await q
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.local, true), eq(actors.kind, 'Application')));
  if (!instanceActor) throw new Error('no local instance actor: run the migrate command with PUBLIC_ORIGIN set');
  return { kind: 'system', actorId: instanceActor.id, job };
}
