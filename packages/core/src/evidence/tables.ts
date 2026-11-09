import { bigint, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { media } from '../db/tables/media.ts';

// Owned by lane SAFE. What is kept about a quarantined image: a manifest of facts, never the
// image (the one stored object stays at its key, under a hold, until it is purged).

const sourceValues = ['provider', 'list'] as const;
const statusValues = ['open', 'confirmed', 'released'] as const;

export const mediaEvidence = pgTable(
  'media_evidence',
  {
    id: id(),
    /** One row per incident: a released image caught again gets a new row, and the earlier one stays as it was. */
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id),
    source: text('source', { enum: sourceValues }).notNull(),
    /** A provider's classification (csam, harmful-abusive-material, test) or, for the list, the entry's category. */
    classification: text('classification').notNull(),
    /** exact or near when the provider says; null otherwise. */
    matchType: text('match_type'),
    manifest: jsonb('manifest').notNull(),
    /** SHA-256 of the manifest's canonical JSON (evidence/manifest.ts), so a changed copy is visible. */
    manifestSha256: text('manifest_sha256').notNull(),
    status: text('status', { enum: statusValues }).notNull().default('open'),
    decidedBy: uuid('decided_by').references(() => actors.id, { onDelete: 'set null' }),
    decidedAt: at('decided_at'),
    note: text('note'),
    /** A police or NCMEC reference for a preservation direction; with `holdUntil`, keeps the object and the manifest. */
    holdReference: text('hold_reference'),
    holdUntil: at('hold_until'),
    /** When the purge claimed the image's bytes (mediascan/purge.ts): from then on a hold is refused, since the bytes are on their way out. */
    purgeStartedAt: at('purge_started_at'),
    /** The decision plus 24 months; a hold postpones it. The purge job deletes the manifest after it. */
    retainUntil: at('retain_until'),
    /** When this incident began (the quarantine); the undecided window runs from it. */
    createdAt: createdAt(),
  },
  (t) => [
    enumCheck('media_evidence_source', t.source, sourceValues),
    enumCheck('media_evidence_status', t.status, statusValues),
    index('media_evidence_status').on(t.status),
    /** An image's incidents, the current (latest) one first. */
    index('media_evidence_media').on(t.mediaId, t.createdAt),
  ],
);

/**
 * Insert-only history of an evidence row: who did what and when. `evidenceId` has no foreign
 * key on purpose, so the line that records an expired manifest outlives the manifest.
 */
export const mediaEvidenceLog = pgTable(
  'media_evidence_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    evidenceId: uuid('evidence_id').notNull(),
    at: at('at').notNull().defaultNow(),
    /** Null for the instance acting as itself. */
    actorId: uuid('actor_id'),
    event: text('event').notNull(),
    note: text('note'),
  },
  (t) => [index('media_evidence_log_evidence').on(t.evidenceId)],
);
