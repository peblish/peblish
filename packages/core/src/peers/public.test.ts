import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { instances } from '../db/tables/instances.ts';
import { writer } from '../db/write.ts';
import { instanceHealth } from '../remote/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { instancesPage } from './public.ts';
import { peerControls } from './tables.ts';

beforeEach(truncateAll);

/** A remote instance with one stored person, its software, version and last-seen time set. */
async function peer(domain: string, software: string | null = 'lemmy') {
  const row = await seedInstance(domain, false);
  await writer()
    .update(instances)
    .set({ software, softwareVersion: software && '0.19.7-secret', lastSeenAt: new Date('2026-01-02T03:04:05Z') })
    .where(eq(instances.id, row.id));
  await seedActor(row, 'Person', `someone_${domain.split('.')[0]}`);
  return row;
}

test('the Instances page lists permitted, active peers by domain, with two fields and nothing else', async () => {
  const local = await seedInstance('feddit.test');
  await seedActor(local, 'Person', 'here');
  await peer('alpha.test');
  await peer('beta.test', null);
  const blocked = await peer('blocked.test');
  const paused = await peer('paused.test');
  const dormant = await peer('dormant.test');
  const quarantined = await peer('quarantined.test');
  await seedInstance('named-only.test', false);
  await writer()
    .insert(peerControls)
    .values([
      { instanceId: blocked.id, blocked: true, reason: 'Spam wave' },
      { instanceId: paused.id, inboxPaused: true },
      { instanceId: quarantined.id, media: 'denied' },
    ]);
  await writer().insert(instanceHealth).values({ instanceId: dormant.id, state: 'dormant', dormantSince: new Date() });

  const page = JSON.parse(JSON.stringify(await instancesPage())) as Record<string, unknown>;
  expect(Object.keys(page)).toEqual(['instances']);
  const rows = page.instances as Record<string, unknown>[];
  expect(rows).toEqual([
    { domain: 'alpha.test', software: 'lemmy' },
    { domain: 'beta.test', software: null },
    // Media controls are not a block: a quarantined or purged peer still federates.
    { domain: 'quarantined.test', software: 'lemmy' },
  ]);
  for (const row of rows) expect(Object.keys(row).sort()).toEqual(['domain', 'software']);
  // No version, last-seen time, control, reason or local row anywhere in what is sent.
  const text = JSON.stringify(page);
  for (const secret of [
    '0.19.7',
    '2026-01-02',
    'Spam wave',
    'feddit.test',
    'blocked.test',
    'paused.test',
    'dormant.test',
    'named-only.test',
  ]) {
    expect(text).not.toContain(secret);
  }
});
