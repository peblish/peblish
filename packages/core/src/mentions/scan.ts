import type { Uuid } from '@peblish/schema/ids';
import { mentionMaxCount } from '@peblish/schema/markdown';
import { type } from 'arktype';
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { renderMarkdown } from '../markdown/render.ts';

// Who a post or comment mentions, among the people of this instance. Two sources: the
// `@name@host` references in our own Markdown (the renderer finds them; only the full form
// counts at launch, as in Lemmy, a bare `@name` is text), and the Mention tags in a peer's
// document, kept in `raw`. Remote people are not notified from here, so a mention of one is
// dropped.

const MentionTag = type({ type: "'Mention'", href: 'string.url' });

/** The https `href`s of the document's Mention tags; `tag` may be one object or an array. */
export function mentionHrefs(raw: unknown): string[] {
  const tag = typeof raw === 'object' && raw !== null && 'tag' in raw ? raw.tag : undefined;
  const items = Array.isArray(tag) ? tag : tag === undefined ? [] : [tag];
  return items.flatMap((item) => {
    const found = MentionTag(item);
    return found instanceof type.errors || !found.href.startsWith('https://') ? [] : [found.href];
  });
}

/**
 * The live local people the body mentions, never the author, at most mentionMaxCount. `bodyMd`
 * is a local body's Markdown (null for a peer's); `raw` the peer's document (null for ours).
 */
export async function findMentioned(
  db: Queryable,
  { bodyMd, raw, authorId }: { bodyMd: string | null; raw: unknown; authorId: Uuid },
): Promise<Uuid[]> {
  const { origin } = await localInstance(db);
  const host = new URL(origin).host;
  const names = bodyMd
    ? renderMarkdown(bodyMd, { baseOrigin: origin }).mentions.flatMap((m) =>
        m.kind === 'person' && m.host === host ? [m.name.toLowerCase()] : [],
      )
    : [];
  const hrefs = mentionHrefs(raw).slice(0, mentionMaxCount);
  if (names.length === 0 && hrefs.length === 0) return [];
  const byName = names.length > 0 ? inArray(sql`lower(${actors.name})`, names) : undefined;
  const byHref = hrefs.length > 0 ? inArray(actors.apId, hrefs) : undefined;
  const rows = await db
    .select({ id: actors.id })
    .from(actors)
    .where(
      and(
        sql`${actors.local} and ${actors.kind} = 'Person'`,
        isNull(actors.deletedAt),
        sql`(${byName ?? sql`false`} or ${byHref ?? sql`false`})`,
      ),
    );
  return rows
    .map(({ id }) => id)
    .filter((id) => id !== authorId)
    .slice(0, mentionMaxCount);
}

/** Whether two peer documents mention the same actors (order and repeats aside): a change is an edit even when the text is not. */
export function sameMentions(before: unknown, after: unknown): boolean {
  const a = new Set(mentionHrefs(before));
  const b = new Set(mentionHrefs(after));
  return a.size === b.size && [...a].every((href) => b.has(href));
}
