import type { Uuid } from '@peblish/schema/ids';
import { ModlogFilter, type ModlogEntry } from '@peblish/schema/modlog';
import { count, eq, getTableColumns, sql } from 'drizzle-orm';
import { db as readDb, type Queryable } from '../db/read.ts';
import { modlog } from '../db/tables/moderation.ts';
import { allOf, createdAtText, encodeCursor, modlogConditions, newestFirst, type ModlogViewer } from './filters.ts';
import { actionGroupNames, actionGroups, type ActionGroup } from './groups.ts';
import { entries } from './read.ts';

// The modlog page (R2 pick modlog-feed): newest first with a keyset cursor on (created_at, id),
// and the counts for the facet rail. Both honour who is reading (filters.ts ModlogViewer).

type Options = { viewer: ModlogViewer | null; trustedInstances?: readonly string[]; db?: Queryable };

export type ModlogPage = {
  entries: ModlogEntry[];
  /** Pass back as `cursor` for the next page; null on the last. */
  next: string | null;
  /** Every row the filter matches, this page and the others. */
  total: number;
  /** Where this page starts among them, counting from 1 ("from to from + entries.length - 1 of total"). */
  from: number;
};

/** One page of the modlog under the filter (its `limit` is the page size, 50 when absent). */
export async function readModlogPage(filter: ModlogFilter, options: Options): Promise<ModlogPage> {
  const valid = ModlogFilter.assert(filter);
  const q = options.db ?? readDb();
  const limit = valid.limit ?? 50;
  const [conditions, counted] = await Promise.all([
    modlogConditions(valid, q, options),
    modlogConditions(valid, q, { ...options, skip: ['cursor'] }),
  ]);
  const [rows, [total], [rest]] = await Promise.all([
    q
      .select({ ...getTableColumns(modlog), cursorAt: createdAtText })
      .from(modlog)
      .where(allOf(conditions))
      .orderBy(...newestFirst)
      .limit(limit + 1),
    q.select({ total: count() }).from(modlog).where(allOf(counted)),
    valid.cursor ? q.select({ rest: count() }).from(modlog).where(allOf(conditions)) : Promise.resolve([undefined]),
  ]);
  const all = total?.total ?? 0;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: await entries(page, q, options.trustedInstances),
    next: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    total: all,
    from: valid.cursor ? all - (rest?.rest ?? all) + 1 : 1,
  };
}

export type ModlogFacets = {
  /** Rows under the filter without its community choice, per community with rows; the most active first. */
  communities: { id: Uuid; apId: string; count: number }[];
  /** Rows another instance's moderators took, under the rest of the filter. */
  remote: number;
  /** Rows per action group, under the filter without its action choice. */
  groups: Record<ActionGroup, number>;
};

/** The most communities the rail lists; the chosen one is always among them. */
const communityFacetLimit = 12;

/** The counts of the facet rail. Each facet counts the rows its own choice would leave, given the others. */
export async function modlogFacets(filter: ModlogFilter, options: Options): Promise<ModlogFacets> {
  const valid = ModlogFilter.assert(filter);
  const q = options.db ?? readDb();
  const [forCommunities, forRemote, forGroups] = await Promise.all([
    modlogConditions(valid, q, { ...options, skip: ['community', 'cursor'] }),
    modlogConditions({ ...valid, remote: true }, q, { ...options, skip: ['cursor'] }),
    modlogConditions(valid, q, { ...options, skip: ['actions', 'cursor'] }),
  ]);
  const inGroup = (group: ActionGroup) =>
    sql<number>`count(*) filter (where ${sql.join(
      actionGroups[group].map((name) =>
        name.endsWith('.*') ? sql`${modlog.action} like ${`${name.slice(0, -1)}%`}` : sql`${modlog.action} = ${name}`,
      ),
      sql` or `,
    )})::int`;
  const [communities, [remote], [groups]] = await Promise.all([
    q
      .select({ id: modlog.communityId, apId: modlog.communityApId, count: count() })
      .from(modlog)
      .where(allOf(forCommunities))
      .groupBy(modlog.communityId, modlog.communityApId)
      .orderBy(sql`count(*) desc`, modlog.communityApId)
      .limit(communityFacetLimit + 1),
    q.select({ remote: count() }).from(modlog).where(allOf(forRemote)),
    q
      .select(
        Object.fromEntries(actionGroupNames.map((group) => [group, inGroup(group)])) as Record<ActionGroup, ReturnType<typeof inGroup>>,
      )
      .from(modlog)
      .where(allOf(forGroups)),
  ]);
  const listed = communities.flatMap((row) => (row.id && row.apId ? [{ id: row.id, apId: row.apId, count: row.count }] : []));
  const chosen = valid.communityId;
  const shown = listed.slice(0, communityFacetLimit);
  if (chosen && !shown.some((row) => row.id === chosen)) {
    const [row] = await q
      .select({ apId: modlog.communityApId, count: count() })
      .from(modlog)
      .where(allOf([...forCommunities, eq(modlog.communityId, chosen)]))
      .groupBy(modlog.communityApId);
    if (row?.apId) shown.push({ id: chosen, apId: row.apId, count: row.count });
  }
  return { communities: shown, remote: remote?.remote ?? 0, groups: groups ?? emptyGroups() };
}

const emptyGroups = (): Record<ActionGroup, number> =>
  Object.fromEntries(actionGroupNames.map((group) => [group, 0])) as Record<ActionGroup, number>;
