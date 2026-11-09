import { beforeEach, expect, test } from 'vitest';
import { writer } from '../db/write.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedInstance } from '../testing/seed.ts';
import { blockedHosts, hostBlocked } from './blocked.ts';

beforeEach(truncateAll);

test('the resolver and the directory see the peers an admin blocked, and only those', async () => {
  await seedInstance('feddit.test');
  const blocked = await seedInstance('blocked.test', false);
  const paused = await seedInstance('paused.test', false);
  await writer()
    .insert(peerControls)
    .values([
      { instanceId: blocked.id, blocked: true },
      { instanceId: paused.id, inboxPaused: true },
    ]);
  expect(await Promise.all(['blocked.test', 'paused.test', 'unknown.test', 'feddit.test'].map(hostBlocked))).toEqual([
    true,
    false,
    false,
    false,
  ]);
  expect(await blockedHosts()).toEqual(['blocked.test']);
});
