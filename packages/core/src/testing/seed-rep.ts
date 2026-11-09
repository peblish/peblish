import { uuidv7 } from 'uuidv7';
import { and, eq } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { outbox } from '../db/tables/outbox.ts';
import { createReportAs } from '../reports/actions.ts';
import { localUser, seedActor } from './seed.ts';
import { seedModerator, seedPost } from './seed-az.ts';
import { posts } from '../db/tables/content.ts';
import { communityModerators, modlog, reports } from '../db/tables/moderation.ts';
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

/**
 * What e2e/reports runs against: accounts that can sign in (lane A's seedAccount), two
 * communities with a moderator each, and posts with open reports in every state the specs need:
 * - `form`: posts to report through the form (with and without JavaScript, and the dialog);
 * - `forwarded`: a post by a person on a remote instance (`farHost`), so a report can be sent on;
 * - `queue.hate`: a post with two reports; `queue.sensitive`: a sensitive post; `queue.other`: a
 *   post in the other community; `queue.adminOnly`: a child-safety report; `queue.remove`,
 *   `queue.escalate`, `queue.dismiss`: posts for the actions; `person`: a report about the author.
 * Every run uses fresh names, so the lane database can keep earlier runs.
 */
async function e2e() {
  const { seedAccount, seedTwoFactor, PASSWORD } = await import('./seed-a.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const here = await localInstance(db());
  const instance = { ...here, domain: new URL(here.origin).host, local: true };
  const [reporter, second, third, author, moderator, outsider] = await Promise.all(
    ['reporter', 'second', 'third', 'author', 'mod', 'outsider'].map((name) => seedAccount(`${name}_${suffix}`)),
  );
  // An admin of this run's own, so signing in with a one-time code does not meet another spec's.
  const boss = await seedAccount(`boss_${suffix}`, { role: 'admin' });
  const { secret } = await seedTwoFactor(boss.userId, `peblish-rep-totp-secret-${suffix}-0123456789`);
  const community = await seedActor(instance, 'Group', `rep_${suffix}`);
  const other = await seedActor(instance, 'Group', `rep_other_${suffix}`);
  await seedModerator(community, { id: moderator!.actorId });
  await seedModerator(other, { id: outsider!.actorId });
  const poster = { id: author!.actorId };
  const post = async (title: string, on = community, extra: Record<string, unknown> = {}) =>
    (await seedPost(instance, on, poster, { title: `${title} ${suffix}`, bodyMd: title, contentHtml: `<p>${title}</p>`, ...extra })).id;
  const report = async (
    who: { actorId: string },
    postId: string,
    category: Parameters<typeof createReportAs>[1]['category'],
    details = '',
  ) => {
    const made = await createReportAs(localUser(who.actorId), { target: { kind: 'post', id: postId }, category, forward: false, details });
    if (!made.ok) throw new Error(`seed report ${category}: ${made.reason}`);
  };
  const posts = {
    form: [await post('Form one'), await post('Form two'), await post('Form three'), await post('Form four')],
    hate: await post('Hateful words'),
    sensitive: await post('Spicy', community, { sensitive: true }),
    other: await post('Other community post', other),
    adminOnly: await post('Child safety case'),
    remove: await post('Remove me'),
    escalate: await post('Escalate me'),
    dismiss: await post('Dismiss me'),
    forwarded: '',
  };
  // A remote author on a host that never resolves (.example): a forwarded Flag fails to deliver, harmlessly.
  const far = await seedInstance(`far-${suffix}.example`, false);
  const farAuthor = await seedActor({ ...far, local: false }, 'Person', `far_${suffix}`, { inboxUrl: `https://${far.domain}/inbox` });
  posts.forwarded = (
    await seedPost(far, community, farAuthor, { title: `Forward me ${suffix}`, bodyMd: 'Forward me', contentHtml: '<p>Forward me</p>' })
  ).id;
  await report(reporter!, posts.hate, 'hate', 'Slurs in the second paragraph');
  await report(second!, posts.hate, 'hate');
  await report(reporter!, posts.sensitive, 'sexual_content');
  await report(reporter!, posts.other, 'spam');
  await report(reporter!, posts.adminOnly, 'child_safety');
  await report(reporter!, posts.remove, 'fraud_illegal', 'Card scam');
  await report(third!, posts.escalate, 'threats_harassment');
  await report(third!, posts.dismiss, 'spam');
  const made = await createReportAs(localUser(reporter!.actorId), {
    target: { kind: 'actor', id: author!.actorId },
    category: 'spam',
    forward: false,
    details: '',
  });
  if (!made.ok) throw new Error(made.reason);
  return {
    password: PASSWORD,
    suffix,
    reporter: { name: reporter!.name },
    second: { name: second!.name },
    author: { name: author!.name, actorId: author!.actorId },
    moderator: { name: moderator!.name },
    outsider: { name: outsider!.name },
    admin: { name: boss.name, totpSecret: secret },
    community: { handle: community.name },
    other: { handle: other.name },
    farHost: far.domain,
    posts,
    titles: {
      hate: `Hateful words ${suffix}`,
      sensitive: `Spicy ${suffix}`,
      other: `Other community post ${suffix}`,
      adminOnly: `Child safety case ${suffix}`,
      remove: `Remove me ${suffix}`,
      escalate: `Escalate me ${suffix}`,
      dismiss: `Dismiss me ${suffix}`,
    },
  };
}

/**
 * What the payload budget visits (e2e/payload/routes.ts): a post by someone else, a report the
 * named admin filed about it, and the report's number for the receipt page.
 */
async function payload(adminName: string) {
  const here = await localInstance(db());
  const instance = { ...here, domain: new URL(here.origin).host, local: true };
  const [admin] = await db()
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.name, adminName), eq(actors.local, true)));
  if (!admin) throw new Error(`no local person ${adminName}`);
  const suffix = Math.random().toString(36).slice(2, 8);
  const author = await seedActor(instance, 'Person', `payload_author_${suffix}`);
  const community = await seedActor(instance, 'Group', `payload_${suffix}`);
  const post = await seedPost(instance, community, author, { title: `Reported post ${suffix}` });
  const made = await createReportAs(localUser(admin.id), {
    target: { kind: 'post', id: post.id },
    category: 'spam',
    forward: false,
    details: '',
  });
  if (!made.ok) throw new Error(made.reason);
  return { postId: post.id, number: made.number };
}

/** What a removal left behind, for the spec: the modlog rows and report events about a post. */
async function after(postId: string) {
  const rows = await db()
    .select({ action: modlog.action, reason: modlog.reason, public: modlog.public })
    .from(modlog)
    .where(eq(modlog.targetPostId, postId));
  const events = await db().select({ type: outbox.type }).from(outbox);
  return { modlog: rows, resolved: events.filter((event) => event.type === 'report.resolved').length };
}

if (import.meta.main) {
  try {
    const [command, argument] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else if (command === 'payload' && argument) console.log(JSON.stringify(await payload(argument)));
    else if (command === 'after' && argument) console.log(JSON.stringify(await after(argument)));
    else throw new Error('usage: node packages/core/src/testing/seed-rep.ts e2e | payload <admin name> | after <post id>');
  } finally {
    await closePools();
  }
}
