import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import { ensureInstance } from '../remote/instances.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { peerControls } from './tables.ts';

// Lane MODF (M18). The admin changes what this server does about one peer: approve or
// quarantine its media, purge it (deny plus a timestamp), pause its inbox, block it. A host
// never seen is added to the instances first, so an admin can block one in advance. The change
// is a non-public modlog row (peer.update) and a peer.updated event.

export const PeerInput = type({
  'media?': "'approved' | 'quarantined'",
  'inboxPaused?': 'boolean',
  'blocked?': 'boolean',
  /** Deny the peer's media for good and record when. */
  'purge?': 'boolean',
  'reason?': 'string <= 10000 | null',
});
export type PeerInput = typeof PeerInput.infer;

export const updatePeer = defineMutation({
  action: 'peer.update',
  emits: ['peer.updated'],
  recheck: true,
  async run(t, grant, input: PeerInput) {
    const valid = PeerInput.assert(input);
    const { id: instanceId, domain, origin } = await ensureInstance(t.db, `https://${grant.subject.domain}`);
    // A peer with no row gets its default row first (the same as no row), so there is always one
    // to lock: two first updates at once then queue on it, instead of both reading "no row" and
    // the later upsert writing the defaults over the earlier one's block.
    await t.db.insert(peerControls).values({ instanceId }).onConflictDoNothing();
    const [before] = await t.db.select().from(peerControls).where(eq(peerControls.instanceId, instanceId)).for('no key update');
    if (!before) throw new Error(`peer controls for ${domain} vanished`);
    const was = { media: before.media, inboxPaused: before.inboxPaused, blocked: before.blocked };
    const now = new Date();
    const next = {
      media: valid.purge ? ('denied' as const) : (valid.media ?? was.media),
      inboxPaused: valid.inboxPaused ?? was.inboxPaused,
      blocked: valid.blocked ?? was.blocked,
    };
    const reason = valid.reason?.trim() ? valid.reason.trim() : null;
    const row = { ...next, reason, purgedAt: valid.purge ? now : before.purgedAt, changedBy: grant.actorId, updatedAt: now };
    await t.db.update(peerControls).set(row).where(eq(peerControls.instanceId, instanceId));
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of ['media', 'inboxPaused', 'blocked'] as const) {
      if (was[key] !== next[key]) changes[key] = { before: was[key], after: next[key] };
    }
    if (valid.purge) changes.purged = { before: before.purgedAt?.toISOString() ?? null, after: now.toISOString() };
    const modlogId = await writeModlog(t.db, grant, {
      community: null,
      target: { apId: origin },
      reason,
      details: { public: false, changes },
    });
    await t.emit({ type: 'peer.updated', v: 1, instanceId, domain, ...next, purged: valid.purge === true, modlogId });
    return { instanceId, modlogId };
  },
});
