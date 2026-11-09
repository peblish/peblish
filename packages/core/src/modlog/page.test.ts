import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { modlog } from '../db/tables/moderation.ts';
import { writer } from '../db/write.ts';
import { removeContent } from '../moderation/remove.ts';
import { truncateAll } from '../testing/db.ts';
import { admin, grantFor, seedAdmin, seedComment, seedModerator, seedPost } from '../testing/seed-az.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { describeTargets } from './describe.ts';
import { readModlogPage, modlogFacets } from './page.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const technik = await seedActor(local, 'Group', 'technik');
  const art = await seedActor(local, 'Group', 'art');
  const remoteGroup = await seedActor(lemmy, 'Group', 'lab');
  const andrew = await seedAdmin(local, 'Andrew');
  const mira = await seedActor(local, 'Person', 'mira');
  const tobi = await seedActor(local, 'Person', 'tobi');
  const lemmyMod = await seedActor(lemmy, 'Person', 'lemmymod');
  await seedModerator(technik, mira);
  await seedModerator(art, tobi);
  return { local, lemmy, technik, art, remoteGroup, andrew, mira, tobi, lemmyMod };
}
type World = Awaited<ReturnType<typeof world>>;

/** One modlog row, written directly so the tests choose its time. */
async function log(
  w: World,
  who: { id: string; apId: string },
  values: {
    action: string;
    community?: { id: string; apId: string } | null;
    createdAt?: string;
    public?: boolean;
    reason?: string | null;
  } & Omit<Partial<typeof modlog.$inferInsert>, 'createdAt'>,
) {
  const { community, createdAt, ...rest } = values;
  const id = uuidv7();
  await writer()
    .insert(modlog)
    .values({
      id,
      actorId: who.id,
      actorApId: who.apId,
      communityId: community?.id ?? null,
      communityApId: community?.apId ?? null,
      authority: { kind: 'site-admin', actorId: who.id },
      ...(createdAt && { createdAt: new Date(createdAt) }),
      ...rest,
    });
  return id;
}

const viewer = (w: World, who: 'public' | 'admin' | 'technik' | 'art') =>
  who === 'public'
    ? null
    : who === 'admin'
      ? { admin: true, moderates: [] }
      : { admin: false, moderates: [who === 'technik' ? w.technik.id : w.art.id] };

describe('readModlogPage', () => {
  test('a cursor walks rows with the same timestamp, and timestamps a millisecond apart, without skipping or repeating one', async () => {
    const w = await world();
    // Seven rows at one instant, then rows 0.1 ms apart (a JavaScript Date cannot tell them apart).
    const ids: string[] = [];
    for (let index = 0; index < 7; index++)
      ids.push(await log(w, w.mira, { action: 'mod.remove', community: w.technik, createdAt: '2026-11-09T10:00:00.000Z' }));
    for (let index = 0; index < 4; index++) {
      const id = uuidv7();
      ids.push(id);
      await writer()
        .execute(sql`insert into modlog (id, action, actor_id, actor_ap_id, community_id, community_ap_id, authority, created_at)
        values (${id}, 'mod.lock', ${w.mira.id}, ${w.mira.apId}, ${w.technik.id}, ${w.technik.apId}, '{"kind":"site-admin","actorId":"${sql.raw(w.mira.id)}"}'::jsonb,
          timestamptz '2026-11-09 11:00:00.123000+00' + ${index * 100} * interval '1 microsecond')`);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await readModlogPage({ limit: 3, ...(cursor && { cursor }) }, { viewer: viewer(w, 'admin') });
      sizes.push(page.entries.length);
      expect(page.total).toBe(11);
      expect(page.from).toBe(seen.length + 1);
      seen.push(...page.entries.map((entry) => entry.id));
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(sizes).toEqual([3, 3, 3, 2]);
    expect([...seen].toSorted()).toEqual([...ids].toSorted());
    expect(new Set(seen).size).toBe(11);
    // Newest first: the microsecond-apart rows lead, latest microsecond first.
    expect(seen.slice(0, 4).every((id) => ids.slice(7).includes(id))).toBe(true);
  });

  test('the public sees public rows; a moderator also their own community’s private rows; an admin all', async () => {
    const w = await world();
    const open = await log(w, w.mira, { action: 'mod.remove', community: w.technik });
    const privateTechnik = await log(w, w.mira, { action: 'mod.ban', community: w.technik, public: false });
    const privateArt = await log(w, w.tobi, { action: 'mod.ban', community: w.art, public: false });
    const siteWide = await log(w, w.andrew, { action: 'settings.update', public: false });
    const ids = async (who: Parameters<typeof viewer>[1]) =>
      (await readModlogPage({}, { viewer: viewer(w, who) })).entries.map((entry) => entry.id).toSorted();
    expect(await ids('public')).toEqual([open]);
    expect(await ids('technik')).toEqual([open, privateTechnik].toSorted());
    expect(await ids('art')).toEqual([open, privateArt].toSorted());
    expect(await ids('admin')).toEqual([open, privateTechnik, privateArt, siteWide].toSorted());
    expect((await readModlogPage({}, { viewer: viewer(w, 'public') })).total).toBe(1);
  });

  test('actions, remote and community narrow the page; remote means the acting actor is not on this instance', async () => {
    const w = await world();
    await log(w, w.mira, { action: 'mod.remove', community: w.technik });
    await log(w, w.mira, { action: 'mod.site_ban' });
    await log(w, w.lemmyMod, {
      action: 'mod.remove',
      community: w.remoteGroup,
      authority: { kind: 'community-announce', communityId: w.remoteGroup.id, announceApId: 'https://lemmy.test/a/1' },
    });
    await log(w, w.mira, { action: 'community.update', community: w.technik });
    const read = async (filter: Parameters<typeof readModlogPage>[0]) =>
      (await readModlogPage(filter, { viewer: viewer(w, 'admin') })).entries.map((entry) => entry.action).toSorted();
    expect(await read({ actions: ['mod.remove'] })).toEqual(['mod.remove', 'mod.remove']);
    expect(await read({ actions: ['mod.ban', 'mod.site_ban'] })).toEqual(['mod.site_ban']);
    expect(await read({ actions: ['community.*'] })).toEqual(['community.update']);
    expect(await read({ remote: true })).toEqual(['mod.remove']);
    expect(await read({ communityId: w.technik.id })).toEqual(['community.update', 'mod.remove']);
    expect(await read({ communityId: w.technik.id, actions: ['mod.remove'] })).toEqual(['mod.remove']);
    expect(await read({ actions: [] })).toEqual([]);
  });

  test('a reason from an instance that is not trusted is withheld, as in readModlog', async () => {
    const w = await world();
    await log(w, w.lemmyMod, { action: 'mod.remove', community: w.remoteGroup, reason: 'Spam' });
    const read = (trustedInstances: string[]) =>
      readModlogPage({}, { viewer: viewer(w, 'public'), trustedInstances }).then((page) => page.entries[0]);
    expect(await read([])).toMatchObject({ reason: null, reasonWithheld: true });
    expect(await read(['lemmy.test'])).toMatchObject({ reason: 'Spam', reasonWithheld: false });
  });
});

describe('modlogFacets', () => {
  test('each facet counts what its own choice would leave under the other filters and the viewer’s audience', async () => {
    const w = await world();
    await log(w, w.mira, { action: 'mod.remove', community: w.technik });
    await log(w, w.mira, { action: 'mod.remove', community: w.technik });
    await log(w, w.tobi, { action: 'mod.ban', community: w.art });
    await log(w, w.mira, { action: 'mod.pin', community: w.technik, public: false });
    await log(w, w.lemmyMod, { action: 'mod.remove', community: w.remoteGroup });
    await log(w, w.andrew, { action: 'mod.site_ban' });
    await log(w, w.andrew, { action: 'settings.update', public: false });
    const asAdmin = { viewer: viewer(w, 'admin') };

    const all = await modlogFacets({}, asAdmin);
    expect(all.groups).toEqual({ removals: 3, bans: 2, locks: 1, community: 0, site: 1 });
    expect(all.remote).toBe(1);
    expect(all.communities.map((row) => [row.apId, row.count])).toEqual([
      [w.technik.apId, 3],
      [w.art.apId, 1],
      [w.remoteGroup.apId, 1],
    ]);

    // Choosing a community narrows the group counts and the remote count, not the community list.
    const inTechnik = await modlogFacets({ communityId: w.technik.id }, asAdmin);
    expect(inTechnik.groups).toEqual({ removals: 2, bans: 0, locks: 1, community: 0, site: 0 });
    expect(inTechnik.remote).toBe(0);
    expect(inTechnik.communities).toHaveLength(3);

    // Choosing a group narrows the community list and the remote count, not the group counts.
    const removals = await modlogFacets({ actions: ['mod.remove', 'mod.restore'] }, asAdmin);
    expect(removals.groups).toEqual(all.groups);
    expect(removals.communities.map((row) => row.count)).toEqual([2, 1]);
    expect(removals.remote).toBe(1);

    const asPublic = await modlogFacets({}, { viewer: null });
    expect(asPublic.groups).toEqual({ removals: 3, bans: 2, locks: 0, community: 0, site: 0 });
  });
});

describe('describeTargets', () => {
  test('handles, and the title or excerpt of removed content only for staff of its community', async () => {
    const w = await world();
    const post = await seedPost(w.local, w.technik, w.tobi);
    const comment = await seedComment(w.local, post, w.tobi, { bodyMd: 'Router for a 1 Gbit line\n\nin a 1960s flat' });
    await removeContent(await grantFor('mod.remove', admin(w.andrew.id), { target: { kind: 'post', id: post.id } }), { reason: 'Spam' });
    await removeContent(await grantFor('mod.remove', localUser(w.mira.id), { target: { kind: 'comment', id: comment.id } }), {
      reason: 'Off topic',
    });
    const entries = (await readModlogPage({}, { viewer: viewer(w, 'admin') })).entries;
    const lines = async (who: Parameters<typeof viewer>[1]) => describeTargets(entries, { viewer: viewer(w, who) });
    const byAction = (found: Awaited<ReturnType<typeof lines>>, kind: string) => found.find((line) => line.target?.kind === kind)!;

    const publicView = await lines('public');
    expect(byAction(publicView, 'post')).toMatchObject({
      staff: false,
      relayed: false,
      target: { kind: 'post', label: null, author: { handle: 'tobi' } },
      community: { handle: 'technik', local: true },
    });
    expect(byAction(publicView, 'comment').target).toMatchObject({ kind: 'comment', label: null });

    const asArt = await lines('art');
    expect(byAction(asArt, 'post').target).toMatchObject({ label: null });
    const asTechnik = await lines('technik');
    expect(byAction(asTechnik, 'post')).toMatchObject({ staff: true, target: { label: post.title } });
    expect(byAction(asTechnik, 'comment').target).toMatchObject({ label: 'Router for a 1 Gbit line in a 1960s flat' });
    expect((await lines('admin')).every((line) => line.staff)).toBe(true);
    expect(asTechnik.find((line) => line.entry.action === 'mod.remove')?.moderator).toMatchObject({
      handle: expect.any(String),
      local: true,
    });
  });

  test('a remote moderator is relayed, a banned person is a person, and a purged actor is named from its ap_id', async () => {
    const w = await world();
    const banId = await log(w, w.lemmyMod, {
      action: 'mod.ban',
      community: w.remoteGroup,
      targetActorId: w.mira.id,
      targetApId: w.mira.apId,
    });
    const gone = await log(w, w.mira, { action: 'mod.site_ban', targetApId: 'https://rogue.test/u/spam' });
    const entries = (await readModlogPage({}, { viewer: viewer(w, 'admin') })).entries;
    const lines = await describeTargets(entries, { viewer: viewer(w, 'admin') });
    expect(lines.find((line) => line.entry.id === banId)).toMatchObject({
      relayed: true,
      moderator: { handle: 'lemmymod@lemmy.test', local: false },
      community: { handle: 'lab@lemmy.test' },
      target: { kind: 'person', person: { handle: 'mira', local: true } },
    });
    expect(lines.find((line) => line.entry.id === gone)).toMatchObject({
      relayed: false,
      target: { kind: 'person', person: { id: null, handle: 'spam@rogue.test' } },
    });
  });
});

// Opt-in (it seeds 100,000 rows): PEBLISH_MODLOG_PERF=1 pnpm exec vitest run --project core packages/core/src/modlog/page.test.ts
describe.skipIf(process.env.PEBLISH_MODLOG_PERF !== '1')('at 100,000 rows', () => {
  test('a page and the facets answer in under 50 ms (p95 of 20), for the public, a moderator and an admin', async () => {
    const w = await world();
    await writer().execute(sql`
      insert into modlog (id, action, actor_id, actor_ap_id, community_id, community_ap_id, authority, public, created_at)
      select gen_random_uuid(),
             (array['mod.remove', 'mod.restore', 'mod.ban', 'mod.lock', 'mod.pin', 'community.update'])[1 + n % 6],
             ${w.mira.id}, ${w.mira.apId},
             case when n % 3 = 0 then ${w.technik.id}::uuid when n % 3 = 1 then ${w.art.id}::uuid else ${w.remoteGroup.id}::uuid end,
             case when n % 3 = 0 then ${w.technik.apId} when n % 3 = 1 then ${w.art.apId} else ${w.remoteGroup.apId} end,
             '{"kind":"site-admin","actorId":"00000000-0000-7000-8000-000000000000"}'::jsonb,
             n % 5 <> 0,
             now() - n * interval '30 seconds'
      from generate_series(1, 100000) as n`);
    await writer().execute(sql`analyze modlog`);
    const budgetMs = 50;
    const slow: string[] = [];
    for (const who of ['public', 'technik', 'admin'] as const) {
      for (const [label, run] of [
        ['first page', () => readModlogPage({ limit: 50 }, { viewer: viewer(w, who) })],
        ['a community', () => readModlogPage({ communityId: w.technik.id }, { viewer: viewer(w, who) })],
        ['removals', () => readModlogPage({ actions: ['mod.remove', 'mod.restore'] }, { viewer: viewer(w, who) })],
        ['remote copies', () => readModlogPage({ remote: true }, { viewer: viewer(w, who) })],
        ['facets', () => modlogFacets({}, { viewer: viewer(w, who) })],
      ] as const) {
        await run();
        const times: number[] = [];
        for (let index = 0; index < 20; index++) {
          const start = performance.now();
          await run();
          times.push(performance.now() - start);
        }
        const p95 = times.toSorted((a, b) => a - b)[Math.floor(times.length * 0.95) - 1]!;
        process.stdout.write(`${who.padEnd(7)} ${label.padEnd(14)} p95 ${p95.toFixed(1)} ms\n`);
        if (p95 >= budgetMs) slow.push(`${who} ${label}: ${p95.toFixed(1)} ms`);
      }
    }
    expect(slow).toEqual([]);
    expect(
      await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(modlog),
    ).toEqual([{ n: 100000 }]);
  }, 600_000);
});
