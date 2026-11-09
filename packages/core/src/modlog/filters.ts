import type { Uuid } from '@peblish/schema/ids';
import type { ModlogFilter } from '@peblish/schema/modlog';
import { and, desc, eq, gte, inArray, like, lt, or, sql, type SQL } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import type { Queryable } from '../db/read.ts';
import { modlog } from '../db/tables/moderation.ts';

// The modlog's WHERE clauses, shared by the plain read (read.ts) and the page (page.ts).

/**
 * Who is reading. Everyone sees the public rows; an admin sees every row, and a moderator also
 * the private rows of the communities they moderate. Pass null for a signed-out reader.
 */
export type ModlogViewer = { admin: boolean; moderates: readonly Uuid[] };

/** The row filter for a viewer: undefined when everything is visible. */
export function visibleTo(viewer: ModlogViewer | null): SQL | undefined {
  if (viewer?.admin) return undefined;
  const publicRows = eq(modlog.public, true);
  if (!viewer || viewer.moderates.length === 0) return publicRows;
  return or(publicRows, inArray(modlog.communityId, [...viewer.moderates]));
}

/** An action pattern as a condition: an exact name, or a prefix when it ends in ".*". */
const actionMatch = (name: string): SQL => (name.endsWith('.*') ? like(modlog.action, `${name.slice(0, -1)}%`) : eq(modlog.action, name));

/** The position after a row, as the page returns it in `next`: Postgres's own timestamp text (microseconds), then the id. */
export const encodeCursor = (createdAt: string, id: Uuid): string => Buffer.from(`${createdAt}|${id}`).toString('base64url');

export function decodeCursor(cursor: string): { createdAt: string; id: Uuid } | null {
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!createdAt || !id || rest.length > 0 || !/^[0-9T:. +-]+$/.test(createdAt) || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { createdAt, id };
}

/** `modlog.created_at` as Postgres prints it, which keeps the microseconds a JavaScript Date drops. */
export const createdAtText = sql<string>`${modlog.createdAt}::text`;

type Options = {
  viewer: ModlogViewer | null;
  /** Leave out these parts of the filter: a facet's count ignores its own choice. */
  skip?: readonly ('community' | 'actions' | 'remote' | 'cursor')[];
};

export async function modlogConditions(filter: ModlogFilter, q: Queryable, { viewer, skip = [] }: Options): Promise<SQL[]> {
  const { communityId, actorId, action, actions, remote, cursor, since, until } = filter;
  const conditions: SQL[] = [];
  const visible = visibleTo(viewer);
  if (visible) conditions.push(visible);
  if (communityId && !skip.includes('community')) conditions.push(eq(modlog.communityId, communityId));
  if (actorId) conditions.push(eq(modlog.actorId, actorId));
  if (action) conditions.push(eq(modlog.action, action));
  if (actions && !skip.includes('actions')) {
    // An empty list matches nothing, as a facet that selected no action name would.
    const matches = actions.map(actionMatch);
    conditions.push(matches.length > 0 ? (or(...matches) ?? sql`false`) : sql`false`);
  }
  if (remote && !skip.includes('remote')) {
    const { origin } = await localInstance(q);
    conditions.push(sql`not starts_with(${modlog.actorApId}, ${`${origin}/`})`);
  }
  if (since) conditions.push(gte(modlog.createdAt, new Date(since)));
  if (until) conditions.push(lt(modlog.createdAt, new Date(until)));
  const position = cursor && !skip.includes('cursor') ? decodeCursor(cursor) : null;
  if (position) conditions.push(sql`(${modlog.createdAt}, ${modlog.id}) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`);
  return conditions;
}

export const newestFirst = [desc(modlog.createdAt), desc(modlog.id)] as const;
export const allOf = (conditions: SQL[]) => and(...conditions);
