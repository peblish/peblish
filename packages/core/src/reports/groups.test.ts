import type { Principal } from '@peblish/schema/authz';
import { beforeEach, describe, expect, test } from 'vitest';
import { truncateAll } from '../testing/db.ts';
import { admin, seedModerationWorld, seedModerator, seedPost } from '../testing/seed-az.ts';
import { localUser, seedActor } from '../testing/seed.ts';
import { createReportAs, resolveReportsAs, routeReportsAs } from './actions.ts';
import type { ReportCategory } from './categories.ts';
import { readQueueByCommunity } from './groups.ts';
import type { QueueTab } from './scope.ts';
import type { ReportTarget } from './types.ts';

beforeEach(truncateAll);

const file = async (principal: Principal, target: ReportTarget, category: ReportCategory = 'spam') => {
  const made = await createReportAs(principal, { target, category, forward: false, details: '' });
  if (!made.ok) throw new Error(`${category}: ${made.reason}`);
};
const viewer = (person: { id: string }, siteRole: 'user' | 'admin' = 'user') => ({ actorId: person.id, siteRole });

/** What the route sends, through the same JSON a page load carries. */
async function payload(who: ReturnType<typeof viewer>, tab: QueueTab = 'open', community?: string) {
  const result = await readQueueByCommunity(who, { tab, sort: 'oldest', community });
  if (!result.ok) throw new Error(result.reason);
  return JSON.parse(JSON.stringify(result)) as typeof result;
}
const summary = (data: Awaited<ReturnType<typeof payload>>) =>
  data.groups.map((group) => ({
    community: group.community?.handle ?? null,
    openCount: group.openCount,
    rows: group.rows.map((row) => `${row.audience}:${row.target.kind}`),
  }));

/**
 * The moderation world (the moderator moderates announcements and closed), with: a post of
 * announcements reported for hate and for child safety (admins only), a remote community's post,
 * a person, and a second local community, kitchen, that someone else moderates, with two posts
 * reported.
 */
async function world() {
  const base = await seedModerationWorld();
  const { people, subjects, instances } = base;
  const local: ReportTarget = { kind: 'post', id: subjects.local.normal.postId };
  const remote: ReportTarget = { kind: 'post', id: subjects.remote.normal.postId };
  const person: ReportTarget = { kind: 'actor', id: people.author.id };
  await file(localUser(people.user.id), local, 'hate');
  await file(localUser(people.admin.id), local, 'child_safety');
  await file(localUser(people.user.id), remote);
  await file(localUser(people.user.id), person);
  const kitchen = await seedActor(instances.local, 'Group', 'kitchen', { displayName: 'Secret kitchen' });
  const cook = await seedActor(instances.local, 'Person', 'cook');
  await seedModerator(kitchen, cook);
  for (const title of ['Knives', 'Ovens']) {
    const post = await seedPost(instances.local, kitchen, people.author, { title });
    await file(localUser(people.user.id), { kind: 'post', id: post.id });
  }
  return { ...base, local, kitchen, mod: viewer(people.moderator), boss: viewer(people.admin, 'admin'), cook: viewer(cook) };
}

describe('the queue by community', () => {
  test('a moderator gets only the communities they moderate, empty ones included, and nothing of any other', async () => {
    const w = await world();
    const data = await payload(w.mod);
    expect(summary(data)).toEqual([
      { community: 'announcements', openCount: 1, rows: ['moderators:post'] },
      { community: 'closed', openCount: 0, rows: [] },
    ]);
    // Nothing of kitchen, the remote community or the admins' reports: no id, handle, name or count.
    const text = JSON.stringify(data);
    for (const secret of [w.kitchen.id, 'kitchen', 'Secret kitchen', w.communities.remote.live.id, 'technology']) {
      expect(text).not.toContain(secret);
    }
    expect(data.groups.some((group) => group.community === null)).toBe(false);
    expect(data.groups.flatMap((group) => group.rows.flatMap((row) => row.categories))).not.toContain('child_safety');
  });

  test('naming a community the moderator does not moderate reads as naming none', async () => {
    const w = await world();
    const none = await payload(w.mod, 'open', 'no-such-community');
    expect(await payload(w.mod, 'open', w.kitchen.id)).toEqual(none);
    expect(await payload(w.mod, 'open', 'kitchen')).toEqual(none);
    expect(await payload(w.mod, 'open', '!kitchen')).toEqual(none);
    expect(none.community).toBeNull();
    // Their own community narrows, by id or by handle.
    const own = await payload(w.mod, 'open', '!announcements');
    expect(own.community).toBe(w.communities.local.live.id);
    expect(summary(own)).toEqual([{ community: 'announcements', openCount: 1, rows: ['moderators:post'] }]);
  });

  test('another moderator gets theirs, counted across all their rows', async () => {
    const w = await world();
    const data = await payload(w.cook);
    expect(summary(data)).toEqual([{ community: 'kitchen', openCount: 2, rows: ['moderators:post', 'moderators:post'] }]);
    expect(JSON.stringify(data)).not.toContain('announcements');
  });

  test('an admin gets every community, and the admins-only and person reports in one group with no community', async () => {
    const w = await world();
    expect(summary(await payload(w.boss)).toSorted((a, b) => String(a.community).localeCompare(String(b.community)))).toEqual([
      { community: 'announcements', openCount: 1, rows: ['moderators:post'] },
      { community: 'kitchen', openCount: 2, rows: ['moderators:post', 'moderators:post'] },
      { community: 'technology@lemmy.test', openCount: 1, rows: ['moderators:post'] },
    ]);
    // The child-safety report is filed in announcements, yet it adds nothing to that community.
    expect(summary(await payload(w.boss, 'admins'))).toEqual([{ community: null, openCount: 2, rows: ['admins:post', 'admins:actor'] }]);
  });

  test('an escalation stays under its community; a closed group holding an admins-only report goes to the admins', async () => {
    const w = await world();
    await routeReportsAs(localUser(w.people.moderator.id), { target: w.local, audience: 'moderators' }, 'admins');
    expect(summary(await payload(w.mod, 'escalated'))).toEqual([{ community: 'announcements', openCount: 1, rows: ['admins:post'] }]);
    expect(summary(await payload(w.boss, 'escalated'))).toEqual([{ community: 'announcements', openCount: 1, rows: ['admins:post'] }]);
    expect(summary(await payload(w.boss, 'admins'))).toEqual([{ community: null, openCount: 2, rows: ['admins:post', 'admins:actor'] }]);
    const done = await resolveReportsAs(admin(w.people.admin.id), { target: w.local, audience: 'admins' }, { resolution: 'resolved' });
    if (!done.ok) throw new Error(done.reason);
    // The admin's resolved group holds the escalation and the child-safety report: no community.
    expect(summary(await payload(w.boss, 'resolved'))).toEqual([{ community: null, openCount: 1, rows: ['admins:post'] }]);
    // The moderator sees only the escalation they sent, under its community.
    const theirs = await payload(w.mod, 'resolved');
    expect(summary(theirs)).toEqual([{ community: 'announcements', openCount: 1, rows: ['admins:post'] }]);
    expect(theirs.groups[0]?.rows[0]?.categories).toEqual(['hate']);
  });
});
