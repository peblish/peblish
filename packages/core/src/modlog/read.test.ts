import { beforeEach, expect, test } from 'vitest';
import { modlog } from '../db/tables/moderation.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { readModlog } from './read.ts';

beforeEach(truncateAll);

async function setup() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const moderator = await seedActor(local, 'Person', 'moderator');
  const remoteModerator = await seedActor(lemmy, 'Person', 'someone');
  const announcements = await seedActor(local, 'Group', 'announcements');
  const technology = await seedActor(lemmy, 'Group', 'technology');
  const entry = async (values: {
    action: string;
    actor: { id: string; apId: string };
    community: { id: string; apId: string };
    at: string;
    reason?: string;
    details?: Record<string, unknown>;
  }) => {
    const [row] = await writer()
      .insert(modlog)
      .values({
        action: values.action,
        actorId: values.actor.id,
        actorApId: values.actor.apId,
        communityId: values.community.id,
        communityApId: values.community.apId,
        reason: values.reason ?? null,
        authority: { kind: 'site-admin', actorId: values.actor.id },
        details: values.details ?? {},
        createdAt: new Date(values.at),
      })
      .returning({ id: modlog.id });
    return row!.id;
  };
  return { moderator, remoteModerator, announcements, technology, entry };
}

test('filters by community, actor, action and time range [since, until), newest first, up to limit', async () => {
  const { moderator, remoteModerator, announcements, technology, entry } = await setup();
  const a = await entry({ action: 'mod.remove', actor: moderator, community: announcements, at: '2026-11-01T10:00:00Z' });
  const b = await entry({ action: 'mod.lock', actor: moderator, community: announcements, at: '2026-11-02T10:00:00Z' });
  const c = await entry({ action: 'mod.remove', actor: remoteModerator, community: technology, at: '2026-11-03T10:00:00Z' });
  const ids = async (filter: Parameters<typeof readModlog>[0]) => (await readModlog(filter, { audience: 'staff' })).map(({ id }) => id);
  expect(await ids({})).toEqual([c, b, a]);
  expect(await ids({ communityId: announcements.id })).toEqual([b, a]);
  expect(await ids({ actorId: remoteModerator.id })).toEqual([c]);
  expect(await ids({ action: 'mod.remove' })).toEqual([c, a]);
  expect(await ids({ since: '2026-11-02T10:00:00Z', until: '2026-11-03T10:00:00Z' })).toEqual([b]);
  expect(await ids({ limit: 1 })).toEqual([c]);
  await expect(readModlog({ limit: 500 }, { audience: 'staff' })).rejects.toThrow(/limit/);
});

test('the public audience sees only public entries; staff see all', async () => {
  const { moderator, announcements, entry } = await setup();
  const open = await entry({ action: 'mod.remove', actor: moderator, community: announcements, at: '2026-11-01T10:00:00Z' });
  const sensitive = await entry({
    action: 'mod.remove',
    actor: moderator,
    community: announcements,
    at: '2026-11-02T10:00:00Z',
    details: { public: false },
  });
  expect((await readModlog({}, { audience: 'public' })).map(({ id, public: shown }) => ({ id, shown }))).toEqual([
    { id: open, shown: true },
  ]);
  expect((await readModlog({}, { audience: 'staff' })).map(({ id, public: shown }) => ({ id, shown }))).toEqual([
    { id: sensitive, shown: false },
    { id: open, shown: true },
  ]);
});

test('a reason written on another instance is shown only when that instance is trusted', async () => {
  const { moderator, remoteModerator, announcements, technology, entry } = await setup();
  await entry({ action: 'mod.remove', actor: moderator, community: announcements, at: '2026-11-01T10:00:00Z', reason: 'Rule 2' });
  await entry({ action: 'mod.remove', actor: remoteModerator, community: technology, at: '2026-11-02T10:00:00Z', reason: 'Spam' });
  const reasons = async (trustedInstances?: string[]) =>
    (await readModlog({}, { audience: 'public', trustedInstances })).map(({ reason, reasonWithheld }) => ({ reason, reasonWithheld }));
  expect(await reasons()).toEqual([
    { reason: null, reasonWithheld: true },
    { reason: 'Rule 2', reasonWithheld: false },
  ]);
  expect(await reasons(['Lemmy.test'])).toEqual([
    { reason: 'Spam', reasonWithheld: false },
    { reason: 'Rule 2', reasonWithheld: false },
  ]);
});
