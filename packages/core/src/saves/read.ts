import { Uuid } from '@peblish/schema/ids';
import type { SavedPage } from '@peblish/schema/views';
import { type } from 'arktype';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { visible } from '../feeds/read.ts';
import { postViews, type PostRow, type Viewer } from '../posts/read.ts';
import { savedPosts } from './tables.ts';

// The Saved page's reader (owner-only): the viewer's saved posts, newest save first, a keyset page at a
// time. A save stays a row while its post is gone, so the page applies what every feed applies
// (feeds/read.ts `visible`: live, open community, past blocks, blocked peers and the age gate): a saved
// post that is later removed, deleted, blocked or gated adds no row. There is no count on purpose, so
// nothing can count a post the page leaves out. Rows come through postViews like a feed's.

export const savedPageSize = 20;

/** Where a page ended: the last row's saved_at in microseconds (exact for what Postgres stores) and its post id. */
const Cursor = type({ v: '1', at: '0 < number.integer <= 9007199254740991', id: Uuid });

function encodeCursor(at: number, id: Uuid): string {
  return Buffer.from(JSON.stringify({ v: 1, at, id })).toString('base64url');
}

/** The cursor a page handed out, or null for anything else (an edited link starts at the first page). */
function decodeCursor(text: string | undefined): typeof Cursor.infer | null {
  if (!text || text.length > 200) return null;
  try {
    const parsed = Cursor(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')));
    return parsed instanceof type.errors ? null : parsed;
  } catch {
    return null;
  }
}

const savedMicros = sql<number>`(extract(epoch from ${savedPosts.savedAt}) * 1000000)::float8`.mapWith(Number);
const microsToInstant = (micros: number) => sql`('epoch'::timestamptz + ${micros}::bigint * interval '1 microsecond')`;

/** One page of the viewer's saved posts; `nextCursor` is null on the last page. */
export async function readSaved(
  viewer: NonNullable<Viewer>,
  request: { cursor?: string | undefined; limit?: number } = {},
  q: Queryable = db(),
): Promise<SavedPage> {
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? savedPageSize), 1), 100);
  const cursor = decodeCursor(request.cursor);
  const conditions = [eq(savedPosts.ownerId, viewer.actorId), ...visible('all', viewer, Date.now())];
  if (cursor) {
    const at = microsToInstant(cursor.at);
    conditions.push(sql`${savedPosts.savedAt} <= ${at} and (${savedPosts.savedAt}, ${savedPosts.postId}) < (${at}, ${cursor.id}::uuid)`);
  }
  const keys = await q
    .select({ id: savedPosts.postId, at: savedMicros, savedAt: savedPosts.savedAt })
    .from(savedPosts)
    .innerJoin(posts, eq(posts.id, savedPosts.postId))
    .where(and(...conditions))
    .orderBy(desc(savedPosts.savedAt), desc(savedPosts.postId))
    .limit(limit + 1);
  const page = keys.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = keys.length > limit && last ? encodeCursor(last.at, last.id) : null;
  if (page.length === 0) return { items: [], nextCursor: null };

  const rows = await q
    .select()
    .from(posts)
    .where(
      inArray(
        posts.id,
        page.map(({ id }) => id),
      ),
    );
  const byId = new Map<string, PostRow>(rows.map((row) => [row.id, row]));
  const views = new Map(
    (
      await postViews(
        page.flatMap(({ id }) => byId.get(id) ?? []),
        viewer,
        q,
      )
    ).map((view) => [view.id, view]),
  );
  return {
    items: page.flatMap(({ id, savedAt }) => {
      const view = views.get(id);
      return view ? [{ ...view, savedAt: savedAt.toISOString() }] : [];
    }),
    nextCursor,
  };
}
