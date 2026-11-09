import { sql } from 'drizzle-orm';
import { beforeAll, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { renderMarkdown } from '../markdown/render.ts';
import { truncateAll } from '../testing/db.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { seedBigThread } from '../testing/seed-d.ts';
import { threadDisplayDepth, threadMaxComments } from './limits.ts';
import { readThread } from './read.ts';

// The plan's "deep threads render in budget" (it names no figure; root's decision): a
// 500-comment thread that reaches level 50 is read and its comments rendered in under 200 ms
// on this machine, and what is sent stops at the depth the component draws. This is the data
// half of the page (the query, the view mapping and the Markdown of every comment sent); the
// web package's budget test adds React's server render of the same list, and e2e/comments
// times the whole page.

const budgetMs = 200;
const size = 500;

let postId: string;
beforeAll(async () => {
  await truncateAll();
  const w = await seedPostWorld();
  postId = w.posts.local.normal;
  await seedBigThread(w.instances.local, { id: postId }, [w.people.reader, w.people.author, w.people.moderator], size, 50);
});

test(`a ${size}-comment thread that reaches level 50 is read and rendered in under ${budgetMs} ms`, async () => {
  const run = async () => {
    const started = performance.now();
    const thread = await readThread(postId, null, { sort: 'hot' });
    const html = thread?.comments.map(({ body }) =>
      body?.kind === 'markdown' ? renderMarkdown(body.source, { baseOrigin: 'https://feddit.test' }).html : '',
    );
    return { thread, html, ms: performance.now() - started };
  };
  // The first run warms the connection and the code; the budget is for a page that is asked for again.
  await run();
  const runs = [await run(), await run(), await run()];
  const best = Math.min(...runs.map(({ ms }) => ms));
  const thread = runs[0]!.thread!;
  expect(best).toBeLessThan(budgetMs);

  // It sends at most the capped depth and the capped page, and the thread really does reach level 50.
  expect(Math.max(...thread.comments.map(({ view }) => view.depth))).toBe(threadDisplayDepth - 1);
  expect(thread.comments.length).toBeLessThanOrEqual(threadMaxComments);
  const [row] = await db().execute<{ deepest: number }>(
    sql`select max(nlevel(path))::int as deepest from comments where post_id = ${postId}`,
  );
  expect(row?.deepest).toBe(50);
});
