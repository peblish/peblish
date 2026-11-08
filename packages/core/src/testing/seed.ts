import type { ActingPrincipal } from '@peblish/schema/authz';
import type { ActorKind } from '@peblish/schema/ids';
import { uuidv7 } from 'uuidv7';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';
import { writer } from '../db/write.ts';

// Test fixtures for any lane's database tests. Never imported by product code (lint).

export async function seedInstance(domain = 'test.local', local = true) {
  const [row] = await writer().insert(instances).values({ domain, local }).returning();
  if (!row) throw new Error('instance insert returned nothing');
  return row;
}

export async function seedActor(instance: { id: string; domain: string; local: boolean }, kind: ActorKind, name: string, extra: Partial<typeof actors.$inferInsert> = {}) {
  const id = uuidv7();
  const path = kind === 'Group' ? `c.${name}` : `u.${name}`;
  const [row] = await writer()
    .insert(actors)
    .values({ id, apId: `https://${instance.domain}/ap/${path}`, kind, local: instance.local, instanceId: instance.id, name, ...extra })
    .returning();
  if (!row) throw new Error('actor insert returned nothing');
  return row;
}

export const localUser = (actorId: string): ActingPrincipal => ({ kind: 'local', actorId, siteRole: 'user' });
