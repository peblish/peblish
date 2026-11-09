import { eq } from 'drizzle-orm';
import { communityBlocks, instanceBlocks, personBlocks } from '../blocks/tables.ts';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { seedModerator, seedPost } from './seed-az.ts';
import { seedReply } from './seed-d.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane E1's seeds (blocks, then profiles). Test code only.

type Row = { id: string };
type BlockTarget = (Row & { kind: string }) | { instance: Row };

/**
 * A block row, as a mutation would leave it but without the follow clean-up or the events.
 * The target is an actor row (a Group goes to the community blocks, anything else to the
 * person blocks) or `{ instance }` for an instance block.
 */
export async function seedBlock(blocker: Row, target: BlockTarget): Promise<void> {
  const db = writer();
  if ('instance' in target) {
    await db.insert(instanceBlocks).values({ blockerId: blocker.id, instanceId: target.instance.id }).onConflictDoNothing();
  } else if (target.kind === 'Group') {
    await db.insert(communityBlocks).values({ blockerId: blocker.id, communityId: target.id }).onConflictDoNothing();
  } else {
    await db.insert(personBlocks).values({ blockerId: blocker.id, blockedId: target.id }).onConflictDoNothing();
  }
}

/**
 * What e2e/blocks and e2e/profiles run against, on fresh names every run (the lane database
 * keeps earlier runs):
 * - accounts that can sign in (lane A's seedAccount): `viewers` v1 to v6 for the blocks specs,
 *   `noisy` and `friend` who post in a local community, `owner` (a profile with a name, a
 *   Markdown bio, posts and comments) and `mod`, who moderates the community;
 * - a remote instance with `remote` (a person with an HTML bio and a post), `bot` (a Service)
 *   and a remote community;
 * - `gone` (a deleted local person) and `private` (opted out of search);
 * - `thread`: a post by `friend` with a comment by `friend`, one by `noisy` and a reply
 *   by `friend` under it;
 * - `adult`: a sensitive community with a post by `owner`.
 */
async function e2e() {
  const { seedAccount, PASSWORD } = await import('./seed-a.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = (await localInstance(db())).origin;
  const here = { ...(await localInstance(db())), domain: new URL(origin).host, local: true };
  const there = await seedInstance(`e1-${suffix}.lemmy.test`, false);

  const viewers = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => seedAccount(`e1v${n}_${suffix}`)));
  const [noisy, friend, owner, mod] = await Promise.all(
    ['noisy', 'friend', 'owner', 'mod'].map((name) => seedAccount(`e1${name}_${suffix}`)),
  );
  await writer()
    .update(actors)
    .set({ displayName: 'Pat Profile', summaryMd: 'I **write** about boats.' })
    .where(eq(actors.id, owner!.actorId));

  const community = await seedActor(here, 'Group', `e1c_${suffix}`);
  await seedModerator(community, { id: mod!.actorId });
  const adult = await seedActor(here, 'Group', `e1adult_${suffix}`, { sensitive: true });
  const remoteCommunity = await seedActor(there, 'Group', `e1rc_${suffix}`);
  const remote = await seedActor(there, 'Person', `e1rem_${suffix}`, {
    displayName: 'Remote Rita',
    summaryHtml: '<p>Hello from <b>elsewhere</b></p>',
    fetchedAt: new Date(Date.now() - 3 * 3_600_000),
  });
  const bot = await seedActor(there, 'Service', `e1bot_${suffix}`);
  const gone = await seedActor(here, 'Person', `e1gone_${suffix}`, { deletedAt: new Date() });
  const privatePerson = await seedActor(here, 'Person', `e1priv_${suffix}`, { indexable: false });

  const post = (title: string, author: { id: string }, extra: Parameters<typeof seedPost>[3] = {}, where = community) =>
    seedPost(here, where, author, { title: `${title} ${suffix}`, bodyMd: title, publishedAt: new Date(), ...extra });
  const noisyPost = await post('Noisy post', { id: noisy!.actorId });
  const friendPost = await post('Friend post', { id: friend!.actorId });
  const remotePost = await post('Remote post', remote);
  const ownerPosts = [];
  for (let n = 0; n < 4; n++)
    ownerPosts.push(await post(`Owner post ${n}`, { id: owner!.actorId }, { publishedAt: new Date(Date.now() - n * 60_000) }));
  await post('Owner adult post', { id: owner!.actorId }, {}, adult);
  const body = (text: string) => ({ bodyMd: text, contentHtml: `<p>${text}</p>` });
  const friendComment = await seedReply(here, friendPost, null, { id: friend!.actorId }, body(`Friendly comment ${suffix}`));
  const noisyComment = await seedReply(here, friendPost, null, { id: noisy!.actorId }, body(`Noisy comment ${suffix}`));
  await seedReply(here, friendPost, noisyComment, { id: friend!.actorId }, body(`Reply under noisy ${suffix}`));
  for (let n = 0; n < 3; n++)
    await seedReply(here, friendPost, friendComment, { id: owner!.actorId }, body(`Owner comment ${n} ${suffix}`));

  return {
    suffix,
    password: PASSWORD,
    viewers: viewers.map(({ name }) => name),
    noisy: { name: noisy!.name, id: noisy!.actorId },
    friend: { name: friend!.name },
    owner: { name: owner!.name, id: owner!.actorId },
    mod: { name: mod!.name },
    community: { name: community.name, id: community.id },
    adult: { name: adult.name },
    remoteHost: there.domain,
    remote: { name: remote.name, handle: `${remote.name}@${there.domain}` },
    remoteCommunity: { name: remoteCommunity.name, handle: `${remoteCommunity.name}@${there.domain}` },
    bot: { handle: `${bot.name}@${there.domain}` },
    gone: { name: gone.name },
    private: { name: privatePerson.name },
    posts: {
      noisy: noisyPost.title,
      friend: friendPost.id,
      friendTitle: friendPost.title,
      remote: remotePost.title,
      owner: ownerPosts.map((row) => row.title),
    },
    comments: { noisy: `Noisy comment ${suffix}`, reply: `Reply under noisy ${suffix}`, friend: `Friendly comment ${suffix}` },
  };
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else throw new Error('usage: node packages/core/src/testing/seed-e1.ts e2e');
  } finally {
    await closePools();
  }
}
