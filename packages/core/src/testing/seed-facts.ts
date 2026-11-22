import { eq } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { instances } from '../db/tables/instances.ts';
import { writer } from '../db/write.ts';
import { peerControls } from '../peers/tables.ts';
import { instanceHealth } from '../remote/tables.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { seedComment, seedCommunityRemoval, seedModerator, seedPost } from './seed-az.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane f-facts' end-to-end worlds, on the lane database (DATABASE_URL from scripts/lane.sh), on
// fresh names every run; each command prints what it made as JSON. Test code only.

/**
 * `instances`: the Instances page's peers. Each has a person stored here, its software, a version
 * and a last-seen time; one is listed as it is, one with no software, and one each blocked, paused
 * and dormant.
 */
async function peers() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const peer = async (name: string, software: string | null) => {
    const row = await seedInstance(`${name}-${suffix}.peers.example`, false);
    await writer()
      .update(instances)
      .set({ software, softwareVersion: software && `9.9.9-${suffix}`, lastSeenAt: new Date('2026-02-03T04:05:06Z') })
      .where(eq(instances.id, row.id));
    await seedActor(row, 'Person', `e2i_${name}_${suffix}`);
    return row;
  };
  const listed = await peer('listed', 'piefed');
  const unknown = await peer('unknown', null);
  const blocked = await peer('blocked', 'lemmy');
  const paused = await peer('paused', 'lemmy');
  const dormant = await peer('dormant', 'lemmy');
  await writer()
    .insert(peerControls)
    .values([
      { instanceId: blocked.id, blocked: true, reason: `Blocked reason ${suffix}` },
      { instanceId: paused.id, inboxPaused: true },
    ]);
  await writer().insert(instanceHealth).values({ instanceId: dormant.id, state: 'dormant', dormantSince: new Date() });
  return {
    suffix,
    listed: listed.domain,
    unknown: unknown.domain,
    hidden: [blocked.domain, paused.domain, dormant.domain],
  };
}

/**
 * `profile`: a local person who moderates an open community, a removed one and a sensitive one;
 * a remote person on a peer whose software is known and one on a peer whose software is not; and a
 * post in German in the open community with comments by two others (three people in the thread).
 */
async function profile() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const local = { ...(await localInstance(db())), local: true };
  const host = new URL(local.origin).host;
  const here = { ...local, domain: host };
  const subject = await seedActor(here, 'Person', `e2f_mod_${suffix}`);
  const open = await seedActor(here, 'Group', `e2f_open_${suffix}`);
  const removed = await seedActor(here, 'Group', `e2f_removed_${suffix}`);
  const sensitive = await seedActor(here, 'Group', `e2f_nsfw_${suffix}`, { sensitive: true });
  for (const community of [open, removed, sensitive]) await seedModerator(community, subject);
  await seedCommunityRemoval(removed);
  const known = await seedInstance(`known-${suffix}.peers.example`, false);
  await writer().update(instances).set({ software: 'mbin' }).where(eq(instances.id, known.id));
  const unknown = await seedInstance(`unknown-${suffix}.peers.example`, false);
  const remote = await seedActor(known, 'Person', `e2f_far_${suffix}`);
  const quiet = await seedActor(unknown, 'Person', `e2f_quiet_${suffix}`);
  const post = await seedPost(here, open, subject, { title: `Facts thread ${suffix}`, language: 'de' });
  for (const author of [remote, quiet, remote]) await seedComment(here, post, author);
  return {
    subject: subject.name,
    open: open.name,
    hidden: [removed.name, sensitive.name],
    remote: `${remote.name}@${known.domain}`,
    quiet: `${quiet.name}@${unknown.domain}`,
    post: post.id,
  };
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'instances') console.log(JSON.stringify(await peers()));
    else if (command === 'profile') console.log(JSON.stringify(await profile()));
    else throw new Error('usage: node packages/core/src/testing/seed-facts.ts instances | profile');
  } finally {
    await closePools();
  }
}
