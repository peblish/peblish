import type { Uuid } from '@peblish/schema/ids';
import type { Handle } from '@peblish/schema/invite';
import { and, eq, sql } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';

/** The instance origin and host, and a formatter for name@host, the way the mocks show local people. */
export async function localHandles(): Promise<{ origin: string; host: string; handle: (name: string) => Handle }> {
  const { origin } = await localInstance(db());
  const host = new URL(origin).host;
  return { origin, host, handle: (name) => ({ name, handle: `${name}@${host}` }) };
}

/**
 * The local person a handle names: name, @name or @name@host for this host, any case. Null
 * for anyone else, a remote handle included.
 */
export async function findLocalPerson(input: string): Promise<{ id: Uuid; name: string } | null> {
  const { host } = await localHandles();
  const [name, at, extra] = input.trim().replace(/^@/, '').split('@');
  if (!name || extra !== undefined || (at !== undefined && at.toLowerCase() !== host.toLowerCase())) return null;
  const [actor] = await db()
    .select({ id: actors.id, name: actors.name })
    .from(actors)
    .where(and(eq(actors.local, true), eq(actors.kind, 'Person'), sql`lower(${actors.name}) = ${name.toLowerCase()}`));
  return actor ?? null;
}

/** "Email or handle" on the sign-in form, as the login email; null when no account matches. */
export async function loginEmail(identifier: string): Promise<string | null> {
  const value = identifier.trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && !value.startsWith('@')) return value.toLowerCase();
  const person = await findLocalPerson(value);
  if (!person) return null;
  const [user] = await db()
    .select({ email: authUser.email })
    .from(actors)
    .innerJoin(authUser, eq(authUser.id, actors.userId))
    .where(eq(actors.id, person.id));
  return user?.email ?? null;
}
