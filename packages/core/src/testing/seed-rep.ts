import { uuidv7 } from 'uuidv7';
import { closePools } from '../db/pools.ts';
import { posts } from '../db/tables/content.ts';
import { communityModerators, reports } from '../db/tables/moderation.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { seedAdmin } from './seed-az.ts';
import { seedInstance } from './seed.ts';

// Lane REP's seeds: a queue the size of the budget (5,000 open reports in 300 communities), and
// what e2e/reports runs against. Test code only.

const chunks = <T>(rows: T[], size = 500): T[][] =>
  Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

/**
 * `communities` communities on one local instance, each with a few posts, and `reports` open
 * spam reports spread over them (two reporters per post). `moderator` moderates the first
 * `moderated` communities; `admin` is a site admin.
 */
export async function seedBudgetWorld({ communities = 300, reports: total = 5000, moderated = 20 } = {}) {
  const instance = await seedInstance('budget.test');
  const admin = await seedAdmin(instance, 'budget_admin');
  const moderator = await writer()
    .insert(actors)
    .values({
      id: uuidv7(),
      apId: `${instance.origin}/ap/u.budget_mod`,
      kind: 'Person',
      local: true,
      instanceId: instance.id,
      name: 'budget_mod',
    })
    .returning()
    .then(([row]) => row!);
  const reporters = Array.from({ length: 40 }, (_, i) => ({
    id: uuidv7(),
    apId: `${instance.origin}/ap/u.reporter${i}`,
    kind: 'Person' as const,
    local: true,
    instanceId: instance.id,
    name: `reporter${i}`,
  }));
  const groups = Array.from({ length: communities }, (_, i) => ({
    id: uuidv7(),
    apId: `${instance.origin}/ap/c.budget${i}`,
    kind: 'Group' as const,
    local: true,
    instanceId: instance.id,
    name: `budget${i}`,
  }));
  for (const rows of chunks([...reporters, ...groups])) await writer().insert(actors).values(rows);
  await writer()
    .insert(communityModerators)
    .values(
      groups
        .slice(0, moderated)
        .map((community) => ({ communityId: community.id, moderatorId: moderator.id, source: 'local' as const, verifiedAt: new Date() })),
    );
  const targets = Math.ceil(total / 2);
  const made = Array.from({ length: targets }, (_, i) => {
    const id = uuidv7();
    return {
      id,
      apId: `${instance.origin}/ap/post/${id}`,
      local: true,
      instanceId: instance.id,
      authorId: reporters[i % reporters.length]!.id,
      communityId: groups[i % groups.length]!.id,
      title: `Reported post ${i}`,
      publishedAt: new Date(),
    };
  });
  for (const rows of chunks(made)) await writer().insert(posts).values(rows);
  const now = Date.now();
  const rows = made.flatMap((post, i) =>
    [1, 2].map((offset) => ({
      local: true,
      instanceId: instance.id,
      reporterId: reporters[(i + offset) % reporters.length]!.id,
      communityId: post.communityId,
      targetPostId: post.id,
      category: 'spam',
      reason: 'seeded',
      createdAt: new Date(now - (i * 2 + offset) * 1000),
    })),
  );
  for (const part of chunks(rows)) await writer().insert(reports).values(part);
  return {
    instance,
    admin,
    moderator,
    communityIds: groups.map((group) => group.id),
    moderatedIds: groups.slice(0, moderated).map((group) => group.id),
  };
}

if (import.meta.main) {
  try {
    throw new Error('usage: node packages/core/src/testing/seed-rep.ts e2e');
  } finally {
    await closePools();
  }
}
