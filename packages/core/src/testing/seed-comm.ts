import { eq } from 'drizzle-orm';
import { createCommunityAs } from '../communities/create.ts';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations, throttles } from '../identity/tables.ts';
import { seedBan, seedModerator, seedPost } from './seed-az.ts';
import { PASSWORD, seedAccount, seedTwoFactor } from './seed-a.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane COMM's seeds for e2e/communities (`node packages/core/src/testing/seed-comm.ts e2e`):
// accounts that can sign in, local communities of each kind, a remote one with a moderator in
// every state, and a secret string in everything a flagged community must not leak. Test code only.

const hour = 3_600_000;

/**
 * - people (all sign in with `password`): `admin` (two-factor, owner of the communities),
 *   `moderator`, `member`, `declared` (a 16+ declaration, no role), `undeclared` and `young`
 *   (none), `banned`;
 * - communities: `open` (rules, languages, a sidebar, posts, a flagged post), `restricted`
 *   (only staff post), `empty`, `quiet` (not indexable), `nsfw` and `nsfwOther` (flagged, with `secret` in their name,
 *   sidebar, rules, moderators and posts), `remote` (a Lemmy community seen from here);
 * - posts: `flaggedInOpen` (sensitive, in the open community), `inNsfw`, `inNsfwOther`, `plain`.
 * Every run uses fresh names, so the lane database can keep earlier runs.
 */
async function e2e() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const secret = `SECRET${suffix.toUpperCase()}`;
  const origin = (await localInstance(db())).origin;
  const local = { ...(await localInstance(db())), domain: new URL(origin).host, local: true };
  await writer().delete(throttles);

  const [admin, moderator, member, declared, undeclared, young, banned] = await Promise.all(
    ['admin', 'moderator', 'member', 'declared', 'undeclared', 'young', 'banned'].map((role) =>
      seedAccount(`${role}_${suffix}`, { role: role === 'admin' ? 'admin' : 'user' }),
    ),
  );
  const totp = await seedTwoFactor(admin!.userId);
  // Sign-up writes a declaration for everyone; this account is the imported kind that has none.
  for (const person of [undeclared!, young!]) await writer().delete(ageDeclarations).where(eq(ageDeclarations.actorId, person.actorId));
  const principal = { kind: 'local' as const, actorId: admin!.actorId, siteRole: 'admin' as const };

  const create = async (name: string, fields: Omit<Parameters<typeof createCommunityAs>[1], 'name'>) => {
    const made = await createCommunityAs(principal, { ...fields, name: `${name}_${suffix}` });
    if (!made.ok) throw new Error(`community ${name}: ${made.reason}`);
    return { id: made.id, handle: made.name };
  };
  const open = await create('open', {
    displayName: `Open ${suffix}`,
    description: `A **friendly** place, ${suffix}.`,
    languages: ['en', 'de'],
    rules: [{ title: 'Be civil', body: 'No harassment.' }, { title: 'Stay on topic' }],
  });
  const restricted = await create('notices', { displayName: `Notices ${suffix}`, postingRestrictedToMods: true });
  const empty = await create('empty', { displayName: `Empty ${suffix}` });
  const quiet = await create('quiet', { displayName: `Quiet ${suffix}`, indexable: false });
  const nsfw = await create('nsfw', {
    displayName: `${secret} name`,
    description: `${secret} sidebar`,
    sensitive: true,
    languages: ['en'],
    rules: [{ title: `${secret} rule`, body: `${secret} rule body` }],
  });
  const nsfwOther = await create('nsfw2', { displayName: `${secret} other`, sensitive: true });
  await seedModerator(open, { id: moderator!.actorId });
  await seedModerator(restricted, { id: moderator!.actorId });
  await seedModerator(nsfw, { id: moderator!.actorId });
  await seedBan(open, { id: banned!.actorId });
  await writer().update(communityModerators).set({ verifiedAt: new Date() }).where(eq(communityModerators.communityId, open.id));

  const author = { id: member!.actorId };
  const post = (community: { id: string }, title: string, extra: Parameters<typeof seedPost>[3] = {}) =>
    seedPost(local, community, author, { title, bodyMd: `${title} body`, contentHtml: `<p>${title} body</p>`, ...extra });
  const plain = await post(open, `Plain post ${suffix}`, { upvotes: 5 });
  await post(open, `Older post ${suffix}`, { publishedAt: new Date(Date.now() - 48 * hour) });
  const flaggedInOpen = await post(open, `${secret} flagged post`, { sensitive: true });
  const inNsfw = await post(nsfw, `${secret} nsfw post`);
  const inNsfwOther = await post(nsfwOther, `${secret} other post`);

  // A Lemmy community this instance has seen: refreshed a day ago, one moderator in each state.
  const lemmy = await seedInstance(`lemmy-${suffix}.test`, false);
  const lab = await seedActor(lemmy, 'Group', 'lab', {
    displayName: 'Lab',
    summaryHtml: '<p>The remote lab.</p>',
    fetchedAt: new Date(Date.now() - 26 * hour),
    publishedAt: new Date('2025-03-01T00:00:00Z'),
  });
  const mods = {
    fresh: await seedActor(lemmy, 'Person', 'fresh'),
    stale: await seedActor(lemmy, 'Person', 'stale'),
    unknown: await seedActor(lemmy, 'Person', 'unknown'),
  };
  await writer()
    .insert(communityModerators)
    .values([
      {
        communityId: lab.id,
        moderatorId: mods.fresh.id,
        source: 'remote',
        verifiedAt: new Date(Date.now() - 2 * hour),
        expiresAt: new Date(Date.now() + 10 * hour),
      },
      {
        communityId: lab.id,
        moderatorId: mods.stale.id,
        source: 'remote',
        verifiedAt: new Date(Date.now() - 30 * hour),
        expiresAt: new Date(Date.now() - 18 * hour),
      },
      { communityId: lab.id, moderatorId: mods.unknown.id, source: 'remote' },
    ]);
  const remotePost = await seedPost(lemmy, lab, mods.fresh, { title: `Remote post ${suffix}`, local: false });

  return {
    password: PASSWORD,
    suffix,
    secret,
    admin: { name: admin!.name, totpSecret: totp.secret },
    people: {
      moderator: moderator!.name,
      member: member!.name,
      declared: declared!.name,
      undeclared: undeclared!.name,
      young: young!.name,
      banned: banned!.name,
    },
    communities: {
      open,
      restricted,
      empty,
      quiet,
      nsfw,
      nsfwOther,
      remote: { id: lab.id, handle: `lab@${lemmy.domain}`, host: lemmy.domain },
    },
    posts: { plain: plain.id, flaggedInOpen: flaggedInOpen.id, inNsfw: inNsfw.id, inNsfwOther: inNsfwOther.id, remote: remotePost.id },
  };
}

/** Whether the person named has a 16+ declaration row, for the e2e check that an under-16 answer saved nothing. */
async function declared(name: string) {
  const [row] = await db()
    .select({ actorId: ageDeclarations.actorId })
    .from(ageDeclarations)
    .innerJoin(actors, eq(actors.id, ageDeclarations.actorId))
    .where(eq(actors.name, name));
  return { declared: row !== undefined };
}

if (import.meta.main) {
  try {
    const [command, name] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else if (command === 'declared' && name) console.log(JSON.stringify(await declared(name)));
    else throw new Error('usage: node packages/core/src/testing/seed-comm.ts e2e | declared <name>');
  } finally {
    await closePools();
  }
}
