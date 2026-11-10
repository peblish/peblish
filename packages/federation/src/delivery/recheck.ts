import { localInstance } from '@peblish/core/db/local-instance';
import { db, type Queryable } from '@peblish/core/db/read';
import { media } from '@peblish/core/db/tables/media';
import { type } from 'arktype';
import { and, inArray, isNotNull, or } from 'drizzle-orm';
import { heldContent } from './records.ts';

// The last look at a queued activity before the worker sends it (C2 of the B07 review). A row's
// body is fixed when it is queued, and a row that failed once waits minutes to hours for its
// retry; by then a moderator may have removed the post, its author deleted it, or the scan
// quarantined its image. A Create, Update or Announce of content (an Announce's inner Create or
// Update unwrapped to its real object) is therefore checked against the content's state now,
// and settles as skipped when it is withheld. Every other activity goes as queued: a Delete or
// an Undo is how peers learn to take content down, and a vote or a Follow carries none.

/** The object types that are content (a post or a comment); anything else, an actor's Update for one, is not checked. */
const contentTypes = new Set(['Page', 'Note', 'Article', 'Question', 'Image', 'Video', 'Event']);
const wrappers = new Set(['Create', 'Update']);

const Node = type({ 'type?': 'string', 'id?': 'string', 'object?': 'unknown' });
const node = (value: unknown) => {
  const out = Node(value);
  return out instanceof type.errors ? null : out;
};

/** The content a Create, Update or Announce sends, by id (and type when it is embedded); null for any other activity. */
export function sentContent(body: string): { id: string; type: string | null } | null {
  const activity = node(JSON.parse(body));
  if (!activity?.type) return null;
  let object = activity.object;
  if (activity.type === 'Announce') {
    const inner = node(object);
    // An announced activity: only a Create or an Update carries content (a Like, a Delete or an Undo does not).
    if (inner?.type && !contentTypes.has(inner.type)) {
      if (!wrappers.has(inner.type)) return null;
      object = inner.object;
    }
  } else if (!wrappers.has(activity.type)) return null;
  if (typeof object === 'string') return { id: object, type: null };
  const content = node(object);
  return content?.id ? { id: content.id, type: content.type ?? null } : null;
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Whether the body names an upload of this instance (`<origin>/media/<id>`) that is no longer
 * servable for a reason peers must respect: quarantined or blocked by the scan, or deleted.
 * Pending and failed rows are not withheld here (the image itself answers 404 until it is clean).
 */
async function mediaWithheld(q: Queryable, body: string): Promise<boolean> {
  if (!body.includes('/media/')) return false;
  const { origin } = await localInstance(q);
  const pattern = new RegExp(`${escape(origin)}/media/(${uuid})`, 'gi');
  const ids = [...new Set([...body.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1].toLowerCase()] : [])))];
  if (ids.length === 0) return false;
  const withheld = await q
    .select({ id: media.id })
    .from(media)
    .where(and(inArray(media.id, ids), or(inArray(media.scanState, ['quarantined', 'blocked']), isNotNull(media.deletedAt))))
    .limit(1);
  return withheld.length > 0;
}

/**
 * Why a queued activity must not be sent any more, or null when it may go: the content it
 * carries is deleted or removed, sits under a deleted or removed post or in a deleted or
 * removed community (records.ts heldContent), is no longer held at all, or shows an upload the
 * scan quarantined or blocked.
 */
export async function withheldReason(body: string, q: Queryable = db()): Promise<string | null> {
  const content = sentContent(body);
  if (!content) return null;
  const held = await heldContent(q, content.id);
  if (!held) return content.type !== null && contentTypes.has(content.type) ? 'the content is no longer held' : null;
  if (!held.servable) return 'the content is deleted or removed';
  if (await mediaWithheld(q, body)) return 'the content shows quarantined media';
  return null;
}
