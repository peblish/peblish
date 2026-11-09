import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { seedComment, seedModerator, seedPost } from './seed-az.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane MODF's seeds: what e2e/{modlog,bans,peers} run against. Test code only.

/**
 * A community with a moderator, an author with a post and a comment in it, a spammer with a few
 * of each, a bystander, and a peer instance with one of its people who posted here. Every run
 * uses fresh names, so the lane database can keep earlier runs. The accounts sign in with
 * `password`; the admin is seed-a's e2e admin (`node seed-a.ts e2e-admin`).
 */
async function e2e() {
  const { seedAccount, seedTwoFactor, PASSWORD } = await import('./seed-a.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const here = await localInstance(db());
  const local = { ...here, domain: new URL(here.origin).host, local: true };
  const [moderator, author, spammer, bystander] = await Promise.all(
    ['mod', 'author', 'spam', 'bystander'].map((role) => seedAccount(`${role}_${suffix}`)),
  );
  if (!moderator || !author || !spammer || !bystander) throw new Error('accounts');
  // An admin of its own, so specs running at once never share a sign-in (two-factor codes count once).
  const admin = await seedAccount(`admin_${suffix}`, { role: 'admin' });
  const totpSecret = 'peblish-e2e-modf-totp-secret-0001';
  await seedTwoFactor(admin.userId, totpSecret);
  const community = await seedActor(local, 'Group', `room_${suffix}`);
  await seedModerator(community, { id: moderator.actorId });
  const post = await seedPost(
    local,
    community,
    { id: author.actorId },
    { title: `Author post ${suffix}`, bodyMd: 'A post', contentHtml: '<p>A post</p>' },
  );
  const comment = await seedComment(
    local,
    post,
    { id: spammer.actorId },
    { bodyMd: `Buy now ${suffix}`, contentHtml: `<p>Buy now ${suffix}</p>` },
  );
  const spamPost = await seedPost(
    local,
    community,
    { id: spammer.actorId },
    { title: `Spam post ${suffix}`, bodyMd: 'Spam', contentHtml: '<p>Spam</p>' },
  );
  const peerDomain = `lemmy-${suffix}.test`;
  const peer = await seedInstance(peerDomain, false);
  const remote = await seedActor(peer, 'Person', `rem_${suffix}`);
  const remotePost = await seedPost(peer, community, remote, {
    title: `Remote post ${suffix}`,
    local: false,
    apId: `https://${peerDomain}/post/${suffix}`,
  });
  return {
    password: PASSWORD,
    suffix,
    community: { id: community.id, handle: community.name },
    admin: { name: admin.name, totpSecret },
    moderator: { name: moderator.name },
    author: { name: author.name },
    spammer: { name: spammer.name, actorId: spammer.actorId },
    bystander: { name: bystander.name },
    posts: { author: post.id, spam: spamPost.id, remote: remotePost.id },
    comments: { spam: comment.id },
    peer: { domain: peerDomain, person: `rem_${suffix}@${peerDomain}` },
  };
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else throw new Error('usage: node packages/core/src/testing/seed-modf.ts e2e');
  } finally {
    await closePools();
  }
}
