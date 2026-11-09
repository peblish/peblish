import { instances } from '@peblish/core/db/tables/instances';
import { deliveries } from '@peblish/core/delivery/tables';
import type { OpenTx } from '@peblish/core/tx/tx';
import { inArray } from 'drizzle-orm';

// Putting activities in the delivery queue (the job in job.ts takes them out). Called inside an
// open transaction, a consumer's `t`, so the rows commit with whatever caused them.

export type NewDeliveries = {
  /** The activity's id, as served at its ap_id. */
  activityApId: string;
  /** The local actor whose key signs the requests. */
  senderId: string;
  /** The activity's exact JSON text, stored once for every inbox. */
  body: string;
  inboxes: readonly string[];
};

/** The type and the id of what an activity's JSON is about, for lookups: `object`, or the object of an Announce's inner activity. */
function describe(body: string): { type: string; objectApId: string | null } {
  const json: unknown = JSON.parse(body);
  const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? { ...value } : {});
  const activity = record(json);
  const object = activity.object;
  const objectApId = typeof object === 'string' ? object : record(object).id;
  return { type: String(activity.type ?? 'Activity'), objectApId: typeof objectApId === 'string' ? objectApId : null };
}

/**
 * Queues `body` for each inbox: one row per (activity, inbox), the same text in every row.
 * Inbox URLs are normalised and de-duplicated (callers pass shared inboxes first, one per
 * instance), anything that is not an https URL is dropped, and a pair already queued is left
 * alone, so calling it again for the same activity is harmless. Returns the rows added.
 */
export async function enqueueDeliveries(t: OpenTx, { activityApId, senderId, body, inboxes }: NewDeliveries): Promise<number> {
  const urls = new Map<string, URL>();
  for (const inbox of inboxes) {
    if (!URL.canParse(inbox)) continue;
    const url = new URL(inbox);
    if (url.protocol === 'https:' && !url.username && !url.password) urls.set(url.href, url);
  }
  if (urls.size === 0) return 0;
  const known = await t.db
    .select({ id: instances.id, domain: instances.domain })
    .from(instances)
    .where(inArray(instances.domain, [...new Set([...urls.values()].map((url) => url.host))]));
  const instanceOf = new Map(known.map((row) => [row.domain, row.id]));
  const { type, objectApId } = describe(body);
  const added = await t.db
    .insert(deliveries)
    .values(
      [...urls.values()].map((url) => ({
        activityApId,
        activityType: type,
        objectApId,
        senderId,
        inboxUrl: url.href,
        instanceId: instanceOf.get(url.host) ?? null,
        body,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: deliveries.id });
  return added.length;
}
