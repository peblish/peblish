import { beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../db/tables/actors.ts';
import { personBlocks } from './tables.ts';
import { readThread } from '../comments/read.ts';
import { removeContent } from '../moderation/remove.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor } from '../testing/seed-az.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { seedBigThread, seedReply } from '../testing/seed-d.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { localUser } from '../testing/seed.ts';

beforeEach(truncateAll);

// Threads collapse a blocked person's comments rather than dropping them: the place, the author
// line, the replies and every count stay, the text goes.

async function world() {
  const w = await seedPostWorld();
  const post = { id: w.posts.local.normal };
  const at = w.instances.local;
  const viewer = (person: { id: string }, siteRole: 'user' | 'admin' = 'user') => ({ actorId: person.id, siteRole });
  const blocked = w.people.author;
  const top = await seedReply(at, post, null, blocked);
  const reply = await seedReply(at, post, top, w.people.reader);
  const nested = await seedReply(at, post, reply, blocked);
  const read = (who: ReturnType<typeof viewer> | null, rootId?: string) =>
    readThread(post.id, who, { sort: 'old', rootId: rootId ?? null });
  return { w, post, at, viewer, blocked, top, reply, nested, read };
}

const byId = (thread: Awaited<ReturnType<typeof readThread>>) => new Map(thread!.comments.map((entry) => [entry.view.id, entry]));

describe('readThread and blocks', () => {
  test('a blocked person is collapsed in place, replies and counts kept', async () => {
    const t = await world();
    await seedBlock(t.w.people.reader, t.blocked);
    const entries = byId(await t.read(t.viewer(t.w.people.reader)));
    for (const comment of [t.top, t.nested]) {
      expect(entries.get(comment.id)?.body).toBeNull();
      expect(entries.get(comment.id)?.view).toMatchObject({ blocked: true, deleted: false, removed: false });
    }
    // The author line stays, the reply under it stays and is the viewer's own, readable.
    expect(entries.get(t.top.id)?.view.author.handle).toBe(t.blocked.name);
    expect(entries.get(t.reply.id)?.body).not.toBeNull();
    expect(entries.get(t.reply.id)?.view.blocked).toBeUndefined();
    expect(entries.get(t.top.id)?.view.counts.comments).toBe(2);
  });

  test('other viewers, and signed-out readers, see the text', async () => {
    const t = await world();
    await seedBlock(t.w.people.reader, t.blocked);
    for (const who of [null, t.viewer(t.w.people.moderator), t.viewer(t.blocked)]) {
      const entries = byId(await t.read(who));
      expect(entries.get(t.top.id)?.body).not.toBeNull();
      expect(entries.get(t.top.id)?.view.blocked).toBeUndefined();
    }
  });

  test('moderators who block someone see the same placeholders', async () => {
    const t = await world();
    await seedBlock(t.w.people.moderator, t.blocked);
    const thread = await t.read(t.viewer(t.w.people.moderator));
    expect(thread?.moderator).toBe(true);
    expect(byId(thread).get(t.top.id)?.view.blocked).toBe(true);
  });

  test('an instance block collapses everyone on that instance', async () => {
    const t = await world();
    const remote = await seedReply(t.w.instances.lemmy, { id: t.post.id }, null, t.w.people.remoteAuthor);
    await seedBlock(t.w.people.reader, { instance: t.w.instances.lemmy });
    const entries = byId(await t.read(t.viewer(t.w.people.reader)));
    expect(entries.get(remote.id)?.body).toBeNull();
    expect(entries.get(remote.id)?.view.blocked).toBe(true);
    expect(entries.get(t.top.id)?.view.blocked).toBeUndefined();
  });

  test("a permalink's own comment is read on purpose; the ones around it stay collapsed", async () => {
    const t = await world();
    await seedBlock(t.w.people.reader, t.blocked);
    const entries = byId(await t.read(t.viewer(t.w.people.reader), t.top.id));
    expect(entries.get(t.top.id)?.body).not.toBeNull();
    expect(entries.get(t.top.id)?.view.blocked).toBeUndefined();
    expect(entries.get(t.nested.id)?.view.blocked).toBe(true);
  });

  test('removed and deleted comments keep their own notes, not the blocked one', async () => {
    const t = await world();
    await seedBlock(t.w.people.reader, t.blocked);
    await removeContent(
      await grantFor('mod.remove', localUser(t.w.people.moderator.id), { target: { kind: 'comment', id: t.nested.id } }),
      {
        reason: 'rule 1',
      },
    );
    const view = byId(await t.read(t.viewer(t.w.people.reader))).get(t.nested.id)?.view;
    expect(view).toMatchObject({ removed: true });
    expect(view?.blocked).toBeUndefined();
  });
});

describe('the budget', () => {
  test('500 comments with 1,000 blocks are read in under 200 ms', async () => {
    const w = await seedPostWorld();
    const post = { id: w.posts.local.normal };
    await seedBigThread(w.instances.local, post, [w.people.reader, w.people.author, w.people.moderator], 500, 50);
    const strangers = await writer()
      .insert(actors)
      .values(
        Array.from({ length: 1_000 }, (_, n) => ({
          apId: `https://lemmy.test/ap/u.s${n}`,
          kind: 'Person' as const,
          local: false,
          instanceId: w.instances.lemmy.id,
          name: `s${n}`,
        })),
      )
      .returning({ id: actors.id });
    await writer()
      .insert(personBlocks)
      .values([
        ...strangers.map((row) => ({ blockerId: w.people.reader.id, blockedId: row.id })),
        { blockerId: w.people.reader.id, blockedId: w.people.author.id },
      ]);
    const viewer = { actorId: w.people.reader.id, siteRole: 'user' as const };
    await readThread(post.id, viewer, { sort: 'hot' });
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const thread = await readThread(post.id, viewer, { sort: 'hot' });
      runs.push(performance.now() - started);
      expect(thread?.comments.some((entry) => entry.view.blocked)).toBe(true);
    }
    expect(Math.min(...runs)).toBeLessThan(200);
  });
});
