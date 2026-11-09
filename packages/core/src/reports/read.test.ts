import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { admin, seedModerationWorld, seedPost } from '../testing/seed-az.ts';
import { seedBudgetWorld } from '../testing/seed-rep.ts';
import { localUser, seedActor } from '../testing/seed.ts';
import { and, eq } from 'drizzle-orm';
import type { Principal } from '@peblish/schema/authz';
import { createReportAs, resolveReportsAs, routeReportsAs } from './actions.ts';
import type { ReportCategory } from './categories.ts';
import { openReportCount } from './count.ts';
import { readQueue, readQueueCommunities, type QueueGroup } from './read.ts';
import type { ReportTarget } from './types.ts';

beforeEach(truncateAll);

const file = async (principal: Principal, target: ReportTarget, category: ReportCategory = 'spam', details = '') => {
  const made = await createReportAs(principal, { target, category, forward: false, details });
  if (!made.ok) throw new Error(`${category}: ${made.reason}`);
};
const viewer = (person: { id: string }, siteRole: 'user' | 'admin' = 'user') => ({ actorId: person.id, siteRole });
const queue = async (who: ReturnType<typeof viewer>, tab: Parameters<typeof readQueue>[1]['tab'] = 'open') => {
  const result = await readQueue(who, { tab, sort: 'oldest' });
  if (!result.ok) throw new Error(result.reason);
  return result.groups;
};
const targets = (groups: QueueGroup[]) => groups.map((group) => `${group.audience}:${group.target.kind}:${group.target.id}`);

/** A report on each of: a normal local post (3 reporters), a remote community's post, a person, and an admins-only category on the local post. */
async function world() {
  const base = await seedModerationWorld();
  const { people, subjects } = base;
  const local: ReportTarget = { kind: 'post', id: subjects.local.normal.postId };
  const remote: ReportTarget = { kind: 'post', id: subjects.remote.normal.postId };
  const person: ReportTarget = { kind: 'actor', id: people.author.id };
  const extra = await seedActor(base.instances.local, 'Person', 'second_reporter');
  for (const reporter of [people.user, people.victim, extra]) await file(localUser(reporter.id), local, 'hate', 'Slurs in the title');
  await file(localUser(people.user.id), remote, 'spam');
  await file(localUser(people.user.id), person, 'spam');
  await file(localUser(people.admin.id), local, 'child_safety');
  return { ...base, local, remote, person, mod: viewer(people.moderator), boss: viewer(people.admin, 'admin') };
}

/** A second post, reported, escalated by the moderator and dismissed by the admin; returns the moderator's Dismissed tab. */
async function escalateAndDismiss(w: Awaited<ReturnType<typeof world>>) {
  const extra = await seedPost(w.instances.local, w.communities.local.live, w.people.author, { title: 'Second' });
  const target: ReportTarget = { kind: 'post', id: extra.id };
  await file(localUser(w.people.user.id), target);
  await routeReportsAs(localUser(w.people.moderator.id), { target, audience: 'moderators' }, 'admins');
  const done = await resolveReportsAs(admin(w.people.admin.id), { target, audience: 'admins' }, { resolution: 'dismissed' });
  if (!done.ok) throw new Error(done.reason);
  return queue(w.mod, 'dismissed');
}

describe('the queue', () => {
  test('groups reports by target and audience; a moderator sees only their communities, an admin sees all', async () => {
    const w = await world();
    const open = await queue(w.mod);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ audience: 'moderators', target: w.local, count: 3, categories: ['hate'] });
    expect(open[0]?.reports.map((row) => row.reporter?.handle).sort()).toEqual(['second_reporter', 'user', 'victim']);
    expect(targets(await queue(w.boss)).sort()).toEqual([`moderators:post:${w.local.id}`, `moderators:post:${w.remote.id}`].sort());
    expect(targets(await queue(w.boss, 'admins')).sort()).toEqual([`admins:actor:${w.person.id}`, `admins:post:${w.local.id}`].sort());
  });

  test('a moderator never reads another community, an admins-only or a person group; others are refused', async () => {
    const w = await world();
    expect(await readQueue(viewer(w.people.user), { tab: 'open', sort: 'oldest' })).toEqual({
      ok: false,
      reason: 'mod.moderator_required',
    });
    expect(await readQueue(w.mod, { tab: 'admins', sort: 'oldest' })).toEqual({ ok: false, reason: 'auth.admin_required' });
    const everything = (
      await Promise.all((['open', 'escalated', 'resolved', 'dismissed'] as const).map((tab) => queue(w.mod, tab)))
    ).flat();
    expect(everything.every((group) => group.audience === 'moderators' && group.target.kind !== 'actor')).toBe(true);
    expect(everything.flatMap((group) => group.categories)).not.toContain('child_safety');
  });

  test('the badge counts open groups the viewer can act on', async () => {
    const w = await world();
    expect(await openReportCount(w.mod)).toBe(1);
    expect(await openReportCount(viewer(w.people.user))).toBe(0);
    // an admin counts every open group: the local post, the remote post, the person, the child-safety group
    expect(await openReportCount(w.boss)).toBe(4);
  });

  test('escalated groups leave the moderator open tab and stay readable to the moderator who sent them', async () => {
    const w = await world();
    await routeReportsAs(localUser(w.people.moderator.id), { target: w.local, audience: 'moderators' }, 'admins');
    expect(await queue(w.mod)).toEqual([]);
    const own = await queue(w.mod, 'escalated');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ audience: 'admins', escalatedBy: { id: w.people.moderator.id } });
    expect((await queue(w.boss, 'escalated')).map((group) => group.target)).toEqual([w.local]);
    expect(await openReportCount(w.mod)).toBe(0);
    expect((await readQueueCommunities(w.mod)).map((community) => community.handle)).toEqual(['announcements', 'closed']);
  });

  test('a former moderator no longer reads the groups they escalated, open or closed', async () => {
    const w = await world();
    const key = { target: w.local, audience: 'moderators' as const };
    await routeReportsAs(localUser(w.people.moderator.id), key, 'admins');
    const dismissed = await escalateAndDismiss(w);
    // removed from announcements; still a moderator of closed, so the queue itself stays open to them
    await writer()
      .delete(communityModerators)
      .where(
        and(eq(communityModerators.communityId, w.communities.local.live.id), eq(communityModerators.moderatorId, w.people.moderator.id)),
      );
    expect(await queue(w.mod, 'escalated')).toEqual([]);
    expect(await queue(w.mod, 'dismissed')).toEqual([]);
    expect(dismissed).toHaveLength(1);
    // the admins still see both
    expect((await queue(w.boss, 'escalated')).map((group) => group.target)).toEqual([w.local]);
  });

  test('the quote is plain, short and withheld for sensitive, removed, deleted and admins-only content', async () => {
    const w = await world();
    const long = 'x'.repeat(300);
    const post = await seedPost(w.instances.local, w.communities.local.live, w.people.author, { title: long });
    const flagged = await seedPost(w.instances.local, w.communities.local.live, w.people.author, { title: 'Spicy', sensitive: true });
    const gone = await seedPost(w.instances.local, w.communities.local.live, w.people.author, { title: 'Gone' });
    for (const row of [post, flagged, gone]) await file(localUser(w.people.user.id), { kind: 'post', id: row.id });
    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, gone.id));
    const groups = await queue(w.mod);
    const subject = (id: string) => groups.find((group) => group.target.id === id)?.subject;
    expect(subject(post.id)).toMatchObject({ kind: 'post', withheld: null, quote: `${'x'.repeat(119)}…` });
    expect(subject(flagged.id)).toMatchObject({ quote: null, withheld: 'sensitive' });
    expect(subject(gone.id)).toMatchObject({ quote: null, withheld: 'removed' });
    const adminOnly = (await queue(w.boss, 'admins')).find((group) => group.target.id === w.local.id);
    expect(adminOnly?.subject).toMatchObject({ quote: null, withheld: 'admins' });
  });
});

describe('the budget', () => {
  test('the queue answers under 50 ms and the badge under 10 ms on 5,000 open reports in 300 communities', async () => {
    const w = await seedBudgetWorld();
    // Autovacuum would have analysed a table this size; the planner needs the counts to pick the index.
    await writer().execute(sql`analyze reports`);
    await writer().execute(sql`analyze community_moderators`);
    const who = [viewer(w.moderator), viewer(w.admin, 'admin')];
    // The 95th percentile of 20 runs, the best of three rounds: a stall from other work on a busy
    // machine should not fail a budget that is about what the query costs.
    const time = async (run: () => Promise<unknown>) => {
      await run();
      const rounds: number[] = [];
      for (let round = 0; round < 3; round++) {
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          await run();
          times.push(performance.now() - start);
        }
        rounds.push(times.sort((a, b) => a - b)[Math.floor(times.length * 0.95) - 1]!);
      }
      return Math.min(...rounds);
    };
    for (const person of who) {
      expect(await time(() => readQueue(person, { tab: 'open', sort: 'oldest' }))).toBeLessThan(50);
      expect(await time(() => readQueue(person, { tab: 'open', sort: 'most' }))).toBeLessThan(50);
      expect(await time(() => openReportCount(person))).toBeLessThan(10);
    }
    expect(await openReportCount(viewer(w.admin, 'admin'))).toBe(2500);
    // the queue's index serves the scan
    const plan = await db().execute<{ 'QUERY PLAN': string }>(
      sql`explain select audience from reports where status = 'open' and audience = 'moderators' and community_id = ${w.moderatedIds[0]!} group by audience`,
    );
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('reports_queue');
  });
});
