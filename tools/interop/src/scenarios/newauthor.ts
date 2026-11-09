// X1: how each peer treats a fresh author's burst of posts. PieFed limits a new account's posts
// per day (no backdating here: the account is new in peblish and so is its actor on PieFed);
// Lemmy and Mbin accept NodeInfo software `peblish`. The result is measured, then pinned.
import { seedAccount } from '@peblish/core/testing/seed-a';
import type { Group } from '../context.ts';
import { PASSWORD, sleep } from '../lab.ts';
import { peblish } from '../peblish.ts';
import { prepare, tag } from './support.ts';

const POSTS = 6;
/**
 * Measured on 2026-11-09 (Lemmy 0.19.21, PieFed 1.8.11, Mbin 1.11): Lemmy and Mbin list every post
 * from a new peblish author (software `peblish` is no obstacle); PieFed answers 200 to all six and
 * lists four. Which two it drops varies run to run, so the count is what is pinned.
 */
const PINNED = { lemmy: POSTS, mbin: POSTS, piefed: 4 } as const;

export const newAuthor: Group = {
  ids: ['X1'],
  async run(ctx) {
    const { rec, community } = ctx;
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);
      await rec.scenario('X1', peer.name, async () => {
        const name = `fresh${ctx.run}${peer.name}`;
        await seedAccount(name, { password: PASSWORD });
        const apIds: string[] = [];
        for (let i = 1; i <= POSTS; i += 1) {
          const post = await peblish.createPost(name, community.id, {
            title: tag(ctx, `X1 post ${i}`, peer),
            bodyMd: `Post ${i} of a new author.`,
          });
          apIds.push(post.apId);
          await sleep(1_000);
        }
        await sleep(20_000);
        const listed = await peer.listPosts(side.token, side.labOnPeer);
        const arrived = apIds.map((apId) => listed.some((post) => post.apId === apId));
        const count = arrived.filter(Boolean).length;
        const pattern = `%X1 post % ${peer.name} ${ctx.run}%`;
        const sent = await ctx.sql<{ state: string; status: number | null }[]>`
          select state, last_status as status from deliveries where inbox_url like ${`${peer.origin}/%`} and body like ${pattern}`;
        const accepted = sent.filter((d) => d.state === 'delivered' && d.status === 200).length;
        const note = `${count} of ${POSTS} posts listed on ${peer.name}, ${accepted} of ${sent.length} deliveries answered 200`;
        if (count !== PINNED[peer.name]) throw new Error(`${note}; expected ${PINNED[peer.name]} listed`);
        return note;
      });
    }
  },
};
