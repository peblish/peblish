import { eq } from 'drizzle-orm';
import { beforeEach, expect, test, vi } from 'vitest';
import { comments, votes } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { drainNotices, say, seedInboxWorld } from '../testing/seed-e2.ts';
import { localUser } from '../testing/seed.ts';
import { watchThreadAs } from '../watches/watches.ts';
import { readInbox } from './read.ts';

// The inbox reads a page from one snapshot: a comment purged after the notices are chosen and
// before they are described cannot leave a row that names its author and links a comment the
// rest of the page no longer has. The purge is slipped in as the first count returns, after the
// list has been read.

const slip = vi.hoisted(() => ({ purge: null as null | (() => Promise<void>) }));
vi.mock('./unread.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./unread.ts')>();
  return {
    ...actual,
    unreadCountOf: async (...args: Parameters<typeof actual.unreadCountOf>) => {
      const counted = await actual.unreadCountOf(...args);
      const purge = slip.purge;
      slip.purge = null;
      if (purge) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await purge();
      }
      return counted;
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });
beforeEach(truncateAll);

test('a comment purged while a page is read is described as the page listed it, from the same snapshot', async () => {
  const w = await seedInboxWorld();
  const postId = w.posts.local.normal;
  const watched = await watchThreadAs(localUser(w.people.reader.id), { postId });
  if (!watched.ok) throw new Error(watched.reason);
  const id = await say(w.people.owner, postId, 'Doomed words');
  await drainNotices();
  slip.purge = async () => {
    await writer().delete(votes).where(eq(votes.commentId, id));
    await writer().delete(comments).where(eq(comments.id, id));
  };
  const page = await readInbox({ actorId: w.people.reader.id, siteRole: 'user' });
  expect(slip.purge).toBeNull();
  expect(page.items).toMatchObject([{ kind: 'thread_reply', commentId: id, actor: { id: w.people.owner.id }, excerpt: 'Doomed words' }]);
  expect(page.unread).toBe(1);
  // The next page, read after the purge, has no such row at all.
  expect((await readInbox({ actorId: w.people.reader.id, siteRole: 'user' })).items).toEqual([]);
});
