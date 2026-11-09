import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { reports } from '../db/tables/moderation.ts';
import { readModlog } from '../modlog/read.ts';
import { truncateAll } from '../testing/db.ts';
import { admin, grantFor, outboxEvents, seedBan, seedModerationWorld, writeCounts } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';
import { removeContent } from '../moderation/remove.ts';
import type { Principal } from '@peblish/schema/authz';
import type { ReportCategory } from './categories.ts';
import { createReportAs, removeFromReportAs, resolveReportsAs, routeReportsAs } from './actions.ts';
import type { ReportTarget } from './types.ts';

beforeEach(truncateAll);

type World = Awaited<ReturnType<typeof seedModerationWorld>>;

const asRemote = (actorId: string): Principal => ({ kind: 'remote', actorId, announcedBy: null });
const post = (world: World, state: keyof World['subjects']['local'] = 'normal'): ReportTarget => ({
  kind: 'post',
  id: world.subjects.local[state].postId,
});
const report = (principal: Principal, target: ReportTarget, category: ReportCategory = 'spam', forward = false, details = '') =>
  createReportAs(principal, { target, category, forward, details });
const reason = async (principal: Principal, target: ReportTarget, category: ReportCategory = 'spam', forward = false, details = '') => {
  const result = await report(principal, target, category, forward, details);
  return result.ok ? 'ok' : result.reason;
};

describe('report.create', () => {
  test('who may report what, with the exact refusal', async () => {
    const world = await seedModerationWorld();
    const { people, subjects } = world;
    const normal = post(world);
    // anonymous callers are refused before any policy runs
    expect(await authorize('report.create', { kind: 'anonymous' }, { target: normal, category: 'spam', forward: false })).toEqual({
      ok: false,
      reason: 'auth.required',
    });
    // own content, a ban, and each state of the target
    expect(await reason(localUser(people.author.id), normal)).toBe('report.self');
    expect(await reason(localUser(people.banned.id), normal)).toBe('community.banned');
    expect(await reason(localUser(people.user.id), post(world, 'removed'))).toBe('target.removed');
    expect(await reason(localUser(people.user.id), post(world, 'deleted'))).toBe('target.deleted');
    expect(await reason(localUser(people.user.id), post(world, 'community removed'))).toBe('community.removed');
    expect(await reason(localUser(people.user.id), { kind: 'comment', id: subjects.local.removed.commentId })).toBe('target.removed');
    expect(await reason(localUser(people.user.id), { kind: 'post', id: '019e0000-0000-7000-8000-000000000000' })).toBe('target.not_found');
    // a user, a moderator, an admin and a remote reporter may report
    expect(await reason(localUser(people.user.id), normal)).toBe('ok');
    expect(await reason(localUser(people.moderator.id), { kind: 'comment', id: subjects.local.normal.commentId })).toBe('ok');
    expect(await reason(admin(people.admin.id), post(world, 'locked'))).toBe('ok');
    expect(await reason(asRemote(people.remoteUser.id), post(world, 'pinned'))).toBe('ok');
    // one open report per reporter and target
    expect(await reason(localUser(people.user.id), normal, 'hate')).toBe('report.duplicate');
  });

  test('categories fit the target and other needs details', async () => {
    const world = await seedModerationWorld();
    const user = localUser(world.people.user.id);
    expect(await reason(user, post(world), 'under_16')).toBe('report.category_invalid');
    expect(await reason(user, { kind: 'actor', id: world.people.author.id }, 'sexual_content')).toBe('report.category_invalid');
    expect(await reason(user, post(world), 'other')).toBe('report.reason_required');
    expect(await reason(user, post(world), 'other', false, 'x'.repeat(2001))).toBe('report.reason_required');
    expect(await reason(user, post(world), 'other', false, 'Wrong community')).toBe('ok');
  });

  test('forwarding needs a category that federates and a remote recipient', async () => {
    const world = await seedModerationWorld();
    const user = localUser(world.people.user.id);
    expect(await reason(user, post(world), 'spam', true)).toBe('report.forward_unavailable');
    const remote = (state: keyof World['subjects']['remote']): ReportTarget => ({ kind: 'post', id: world.subjects.remote[state].postId });
    // a child-safety report never leaves the instance, whoever the recipient is
    expect(await reason(user, remote('normal'), 'child_safety', true)).toBe('report.forward_unavailable');
    expect(await reason(asRemote(world.people.remoteUser.id), post(world, 'locked'), 'other', true, 'x')).toBe(
      'report.forward_unavailable',
    );
    const sent = await report(user, remote('locked'), 'spam', true);
    expect(sent.ok && sent.apId).toMatch(/\/ap\/activity\//);
    const kept = await report(user, remote('pinned'), 'spam', false);
    expect(kept.ok && kept.apId).toBeNull();
    // the Flag is not stored as an activity (the activities table is served by id)
    expect((await db().execute(sql`select count(*)::int as n from activities`))[0]).toEqual({ n: 0 });
  });

  test('a report about a person or community goes to the admins and never federates', async () => {
    const world = await seedModerationWorld();
    const user = localUser(world.people.user.id);
    const person: ReportTarget = { kind: 'actor', id: world.people.author.id };
    expect(await reason(user, person, 'spam', true)).toBe('report.forward_unavailable');
    expect(await reason(user, { kind: 'actor', id: world.people.user.id })).toBe('report.self');
    expect(await reason(user, { kind: 'actor', id: '019e0000-0000-7000-8000-000000000000' })).toBe('target.not_found');
    expect(await reason(user, { kind: 'actor', id: world.communities.remote.removed.id })).toBe('community.removed');
    expect(await reason(user, { kind: 'actor', id: world.communities.local.live.id }, 'hate')).toBe('ok');
    const made = await report(user, person, 'under_16');
    expect(made.ok).toBe(true);
    const rows = await db().select().from(reports).orderBy(reports.number);
    expect(rows.map((row) => [row.audience, row.communityId === null])).toEqual([
      ['admins', false],
      ['admins', true],
    ]);
  });

  test('a filed report is one row and one report.created event in the same transaction', async () => {
    const world = await seedModerationWorld();
    const result = await report(localUser(world.people.user.id), post(world), 'hate', false, 'Slurs in the title');
    if (!result.ok) throw new Error(result.reason);
    const [row] = await db().select().from(reports);
    expect(row).toMatchObject({
      id: result.id,
      number: result.number,
      local: true,
      reporterId: world.people.user.id,
      communityId: world.communities.local.live.id,
      targetPostId: world.subjects.local.normal.postId,
      category: 'hate',
      reason: 'Slurs in the title',
      audience: 'moderators',
      status: 'open',
      apId: null,
    });
    expect(await outboxEvents()).toEqual([
      {
        type: 'report.created',
        v: 1,
        reportId: result.id,
        number: result.number,
        reporterId: world.people.user.id,
        communityId: world.communities.local.live.id,
        target: { kind: 'post', id: world.subjects.local.normal.postId },
        category: 'hate',
        audience: 'moderators',
        forward: false,
        apId: null,
        local: true,
      },
    ]);
    const [same] = await db().execute<{ same: boolean }>(
      sql`select (select (tx_id::text::numeric % 4294967296)::text from outbox) = (select xmin::text from reports) as same`,
    );
    expect(same?.same).toBe(true);
  });
});

/** One group of two reports about the normal local post, plus a second post's one report. */
async function queueWorld() {
  const world = await seedModerationWorld();
  const { people, subjects } = world;
  const target = post(world);
  for (const reporter of [people.user, people.victim]) {
    const made = await report(localUser(reporter.id), target, 'hate', false, 'Slurs');
    if (!made.ok) throw new Error(made.reason);
  }
  const key = { target, audience: 'moderators' as const };
  return { ...world, target, key, mod: localUser(people.moderator.id), boss: admin(people.admin.id), subjects };
}

describe('resolve, dismiss and route', () => {
  test('a moderator of the community or an admin closes the group; others are refused exactly', async () => {
    const world = await queueWorld();
    const { people } = world;
    expect(await resolveReportsAs({ kind: 'anonymous' }, world.key, { resolution: 'resolved' })).toEqual({
      ok: false,
      reason: 'auth.required',
    });
    expect(await resolveReportsAs(localUser(people.user.id), world.key, { resolution: 'dismissed' })).toEqual({
      ok: false,
      reason: 'mod.moderator_required',
    });
    await seedBan(world.communities.local.live, people.expired);
    expect(await resolveReportsAs(localUser(people.expired.id), world.key, { resolution: 'dismissed' })).toEqual({
      ok: false,
      reason: 'community.banned',
    });
    const before = await writeCounts();
    expect(await resolveReportsAs(world.mod, world.key, { resolution: 'dismissed', note: 'Not a slur' })).toEqual({ ok: true, count: 2 });
    const rows = await db().select().from(reports);
    expect(
      rows.every((row) => row.status === 'dismissed' && row.resolution === 'dismissed' && row.resolvedBy === people.moderator.id),
    ).toBe(true);
    expect(rows.every((row) => row.resolutionNote === 'Not a slur' && row.resolvedAt !== null)).toBe(true);
    // no modlog row for a dismissal; the event carries every report
    expect((await writeCounts())?.modlog).toBe(before?.modlog);
    const event = (await outboxEvents()).at(-1);
    expect(event).toMatchObject({
      type: 'report.resolved',
      resolution: 'dismissed',
      audience: 'moderators',
      modlogId: null,
      resolvedBy: people.moderator.id,
    });
    expect((event as { reports: unknown[] }).reports).toHaveLength(2);
    // The rows and the event commit together: both carry the same transaction id.
    const [same] = await db().execute<{ same: boolean }>(
      sql`select (select (tx_id::text::numeric % 4294967296)::text from outbox where type = 'report.resolved') = (select distinct xmin::text from reports where status = 'dismissed') as same`,
    );
    expect(same?.same).toBe(true);
    expect(await resolveReportsAs(world.boss, world.key, { resolution: 'resolved' })).toEqual({ ok: false, reason: 'report.not_open' });
  });

  test('a moderator of one community never reaches another community or an admins group', async () => {
    const world = await queueWorld();
    const { people, subjects } = world;
    const other = { kind: 'post' as const, id: subjects.remote.normal.postId };
    expect(await report(localUser(people.user.id), other, 'spam')).toMatchObject({ ok: true });
    const elsewhere = { target: other, audience: 'moderators' as const };
    expect(await resolveReportsAs(world.mod, elsewhere, { resolution: 'resolved' })).toEqual({
      ok: false,
      reason: 'mod.moderator_required',
    });
    // an admins' group: a moderator is not an admin
    const person: ReportTarget = { kind: 'actor', id: people.author.id };
    await report(localUser(people.user.id), person, 'spam');
    const admins = { target: person, audience: 'admins' as const };
    expect(await resolveReportsAs(world.mod, admins, { resolution: 'resolved' })).toEqual({ ok: false, reason: 'auth.admin_required' });
    expect(await resolveReportsAs(world.boss, admins, { resolution: 'resolved' })).toEqual({ ok: true, count: 1 });
  });

  test('a moderator escalates, an admin sends it back, and admin-only reports cannot be sent back', async () => {
    const world = await queueWorld();
    const { people } = world;
    const toAdmins = { ...world.key, audience: 'moderators' as const };
    expect(await routeReportsAs(localUser(people.user.id), toAdmins, 'admins')).toEqual({ ok: false, reason: 'mod.moderator_required' });
    expect(await routeReportsAs(world.mod, toAdmins, 'moderators')).toEqual({ ok: false, reason: 'report.not_open' });
    expect(await routeReportsAs(world.mod, toAdmins, 'admins')).toEqual({ ok: true, count: 2 });
    const [escalated] = await db().select().from(reports).limit(1);
    expect(escalated).toMatchObject({ audience: 'admins', escalatedBy: people.moderator.id });
    expect((await outboxEvents()).at(-1)).toMatchObject({ type: 'report.routed', to: 'admins', by: people.moderator.id });
    // the moderator can no longer resolve it
    expect(await resolveReportsAs(world.mod, world.key, { resolution: 'resolved' })).toEqual({ ok: false, reason: 'report.not_open' });
    const inAdmins = { target: world.target, audience: 'admins' as const };
    expect(await routeReportsAs(world.mod, inAdmins, 'moderators')).toEqual({ ok: false, reason: 'auth.admin_required' });
    expect(await routeReportsAs(world.boss, inAdmins, 'moderators')).toEqual({ ok: true, count: 2 });
    expect((await db().select().from(reports).limit(1))[0]).toMatchObject({ audience: 'moderators', escalatedBy: null, escalatedAt: null });
    // a person report started with the admins and has no moderators to go back to
    const person: ReportTarget = { kind: 'actor', id: people.author.id };
    await report(localUser(people.user.id), person, 'hate');
    expect(await routeReportsAs(world.boss, { target: person, audience: 'admins' }, 'moderators')).toEqual({
      ok: false,
      reason: 'report.admin_only',
    });
  });

  test('sending back moves only the rows a moderator escalated', async () => {
    const world = await queueWorld();
    const { people } = world;
    await routeReportsAs(world.mod, world.key, 'admins');
    // a child-safety report on the same post joins the admins' group at creation
    const sensitive = await report(localUser(people.admin.id), world.target, 'child_safety');
    expect(sensitive.ok).toBe(true);
    const inAdmins = { target: world.target, audience: 'admins' as const };
    expect(await routeReportsAs(world.boss, inAdmins, 'moderators')).toEqual({ ok: true, count: 2 });
    const categories = await db().select({ category: reports.category, audience: reports.audience }).from(reports).orderBy(reports.number);
    expect(categories.filter((row) => row.category === 'child_safety').map((row) => row.audience)).toEqual(['admins']);
  });
});

describe('removal from a report', () => {
  const removeInput = { rule: 5, explanation: 'Targeted slurs aimed at one person.' };

  test('removes the content, writes the statement without the reporters, and resolves the group', async () => {
    const world = await queueWorld();
    const { people } = world;
    const result = await removeFromReportAs(world.mod, world.key, removeInput);
    expect(result).toEqual({ ok: true, count: 2 });
    const [removed] = await db().select({ removedAt: posts.removedAt }).from(posts).where(eq(posts.id, world.subjects.local.normal.postId));
    expect(removed?.removedAt).toBeInstanceOf(Date);
    const [log] = await readModlog({ communityId: world.communities.local.live.id }, { audience: 'public' });
    expect(log).toMatchObject({ action: 'mod.remove', actorId: people.moderator.id, public: true });
    expect(log?.reason).toContain('community rule 5');
    expect(log?.reason).toContain('Targeted slurs aimed at one person.');
    for (const person of [people.user, people.victim]) expect(log?.reason).not.toContain(person.apId);
    const rows = await db().select().from(reports);
    expect(rows.every((row) => row.resolution === 'removed' && row.status === 'resolved' && row.modlogId === log?.id)).toBe(true);
    const event = (await outboxEvents()).at(-1);
    expect(event).toMatchObject({ type: 'report.resolved', resolution: 'removed', modlogId: log?.id });
  });

  test('an admin-only report keeps its modlog row out of the public log', async () => {
    const world = await queueWorld();
    const { people } = world;
    await report(localUser(people.admin.id), world.target, 'intimate_image');
    const key = { target: world.target, audience: 'admins' as const };
    expect(await removeFromReportAs(world.mod, key, removeInput)).toEqual({ ok: false, reason: 'auth.admin_required' });
    expect(await removeFromReportAs(world.boss, key, removeInput)).toEqual({ ok: true, count: 1 });
    expect(await readModlog({ communityId: world.communities.local.live.id }, { audience: 'public' })).toEqual([]);
    const staff = await readModlog({ communityId: world.communities.local.live.id }, { audience: 'staff' });
    expect(staff).toHaveLength(1);
    expect(staff[0]?.public).toBe(false);
  });

  test('content a moderator already removed counts as done, with no second modlog row', async () => {
    const world = await queueWorld();
    const target = { kind: 'post' as const, id: world.subjects.local.normal.postId };
    await removeContent(await grantFor('mod.remove', world.mod, { target }), { reason: 'By hand' });
    const before = await writeCounts();
    expect(await removeFromReportAs(world.mod, world.key, removeInput)).toEqual({ ok: true, count: 2 });
    expect((await writeCounts())?.modlog).toBe(before?.modlog);
    expect((await db().select().from(reports)).every((row) => row.resolution === 'removed' && row.modlogId === null)).toBe(true);
  });

  test('a missing explanation or rule removes nothing, and a person report cannot be removed', async () => {
    const world = await queueWorld();
    const { people } = world;
    expect(await removeFromReportAs(world.mod, world.key, { rule: 5, explanation: ' ' })).toEqual({
      ok: false,
      reason: 'report.reason_required',
    });
    expect(await removeFromReportAs(world.mod, world.key, { rule: 9, explanation: 'x' })).toEqual({
      ok: false,
      reason: 'report.reason_required',
    });
    const [still] = await db().select({ removedAt: posts.removedAt }).from(posts).where(eq(posts.id, world.subjects.local.normal.postId));
    expect(still?.removedAt).toBeNull();
    const person: ReportTarget = { kind: 'actor', id: people.author.id };
    await report(localUser(people.user.id), person, 'spam');
    expect(await removeFromReportAs(world.boss, { target: person, audience: 'admins' }, removeInput)).toEqual({
      ok: false,
      reason: 'report.not_content',
    });
    expect((await writeCounts())?.modlog).toBe(0);
  });

  test('once removed, further reports on the post are refused', async () => {
    const world = await queueWorld();
    await removeFromReportAs(world.mod, world.key, removeInput);
    expect(await report(localUser(world.people.author.id), world.target)).toEqual({ ok: false, reason: 'target.removed' });
  });
});
