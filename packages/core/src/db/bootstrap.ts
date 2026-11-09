import { instanceActorUrls } from '@peblish/schema/actor-urls';
import { killSwitches, siteSettings as contract } from '@peblish/schema/site-settings';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { newRsaKeyPair } from '../actor-keys.ts';
import { canonicalOrigin } from '../config.ts';
import { actorKeys, actors } from './tables/actors.ts';
import { instances } from './tables/instances.ts';
import { siteSettings } from './tables/site.ts';
import type { Writer } from './write.ts';

/**
 * Creates the local instance row and the instance actor (kind Application, ap_id at the
 * origin's root, named after the host, with its inbox, outbox and shared inbox and an
 * RSA-2048 keypair) for `origin` once, backfills missing endpoints on an instance actor
 * created before it had them (set ones are kept), and refuses a different canonical
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
    const urls = instanceActorUrls(canonical);
    await tx
      .insert(actors)
      .values({
        apId: urls.apId,
        kind: 'Application',
        local: true,
        instanceId: local.id,
        name: domain,
        inboxUrl: urls.inbox,
        outboxUrl: urls.outbox,
        sharedInboxUrl: urls.sharedInbox,
      })
      .onConflictDoNothing();
    const [instanceActor] = await tx
      .select({ id: actors.id, apId: actors.apId })
      .from(actors)
      .where(and(eq(actors.local, true), eq(actors.kind, 'Application')));
    if (!instanceActor) throw new Error('the instance actor is missing');
    // An instance actor bootstrapped before it had endpoints gets them; set ones are kept.
    await tx
      .update(actors)
      .set({
        inboxUrl: sql`coalesce(${actors.inboxUrl}, ${urls.inbox})`,
        outboxUrl: sql`coalesce(${actors.outboxUrl}, ${urls.outbox})`,
        sharedInboxUrl: sql`coalesce(${actors.sharedInboxUrl}, ${urls.sharedInbox})`,
      })
      .where(and(eq(actors.id, instanceActor.id), or(isNull(actors.inboxUrl), isNull(actors.outboxUrl), isNull(actors.sharedInboxUrl))));
    const [key] = await tx
      .select({ id: actorKeys.id })
      .from(actorKeys)
      .where(and(eq(actorKeys.actorId, instanceActor.id), eq(actorKeys.algorithm, 'rsa')));
    if (!key) {
      const pair = await newRsaKeyPair();
      await tx
        .insert(actorKeys)
        .values({ actorId: instanceActor.id, keyId: `${instanceActor.apId}#main-key`, algorithm: 'rsa', ...pair })
        .onConflictDoNothing();
    }
  });
}

/** The settings whose readers lock their row: every kill switch and the registration cap. */
export const lockedSettings = [...killSwitches, 'registration.cap'] as const;

/**
 * Writes the default row of every setting a policy reads FOR SHARE, where none exists, and
 * keeps stored ones. A lock on a row that is missing locks nothing, so without the row the first
 * change of a switch could miss a write in flight.
 */
export async function ensureSettingRows(db: Writer): Promise<void> {
  await db
    .insert(siteSettings)
    .values(lockedSettings.map((key) => ({ key, value: contract[key].default })))
    .onConflictDoNothing();
}
