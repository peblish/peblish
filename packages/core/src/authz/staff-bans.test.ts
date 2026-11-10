import { beforeEach, expect, test } from 'vitest';
import { siteBans } from '../bans/tables.ts';
import { moderatedCommunities } from '../bans/read.ts';
import { writer } from '../db/write.ts';
import { createReportAs } from '../reports/actions.ts';
import { openReportCount } from '../reports/count.ts';
import { readQueue, readQueueCommunities } from '../reports/read.ts';
import { truncateAll } from '../testing/db.ts';
import { seedModerationWorld } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';
import { authorize } from './authorize.ts';

beforeEach(truncateAll);

// B07 A3: a site-banned moderator keeps the moderator row but has no staff read authority,
// as the principal refresh already refuses their writes.
test('a site-banned moderator reads no report queue, report count, private modlog or report action', async () => {
  const { people, subjects } = await seedModerationWorld();
  const target = { kind: 'post' as const, id: subjects.local.normal.postId };
  const made = await createReportAs(localUser(people.user.id), { target, category: 'spam', forward: false, details: '' });
  if (!made.ok) throw new Error(made.reason);
  const mod = { actorId: people.moderator.id, siteRole: 'user' as const };
  const resolve = () => authorize('report.resolve', localUser(people.moderator.id), { target, audience: 'moderators' });
  expect(await openReportCount(mod)).toBe(1);
  expect((await resolve()).ok).toBe(true);

  await writer().insert(siteBans).values({ actorId: people.moderator.id, source: 'local' });

  expect(await readQueue(mod, { tab: 'open', sort: 'oldest' })).toEqual({ ok: false, reason: 'mod.moderator_required' });
  expect(await openReportCount(mod)).toBe(0);
  expect(await readQueueCommunities(mod)).toEqual([]);
  // The modlog shows private rows to the communities this returns.
  expect(await moderatedCommunities(people.moderator.id)).toEqual([]);
  // An unlocked decision (a preview, a read) refuses as the recheck would, whatever the role cache holds.
  expect(await resolve()).toEqual({ ok: false, reason: 'auth.site_banned' });

  // An expired ban grants nothing: the authority comes back.
  await writer()
    .update(siteBans)
    .set({ expiresAt: new Date(Date.now() - 1000) });
  expect(await openReportCount(mod)).toBe(1);
});
