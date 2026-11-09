import { index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { media } from '../db/tables/media.ts';

// Owned by lane SAFE. The blocked-image list and the scanner's bookkeeping; the scan state
// itself lives on `media` (db/tables/media.ts) and the evidence of a match in evidence/tables.ts.

const kindValues = ['sha256'] as const;
const categoryValues = ['csam', 'intimate_image', 'violent', 'spam', 'other'] as const;

/**
 * Images this instance refuses, by hash. `kind` is the seam for a later perceptual hash; only
 * the exact SHA-256 of the stored (metadata-cleaned) bytes is matched today. An upload whose
 * hash is listed is quarantined with no provider call.
 */
export const mediaBlocklist = pgTable(
  'media_blocklist',
  {
    id: id(),
    kind: text('kind', { enum: kindValues }).notNull().default('sha256'),
    /** Lowercase hex for `sha256`. */
    value: text('value').notNull(),
    category: text('category', { enum: categoryValues }).notNull(),
    reason: text('reason'),
    addedBy: uuid('added_by').references(() => actors.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('media_blocklist_value').on(t.kind, t.value),
    enumCheck('media_blocklist_kind', t.kind, kindValues),
    enumCheck('media_blocklist_category', t.category, categoryValues),
  ],
);

/**
 * One row per media row the scan job has touched: how many times it was tried, the lease that
 * keeps two workers off one row, and the last failure (a class of error and a status, never a
 * credential or a URL).
 */
export const mediaScans = pgTable(
  'media_scans',
  {
    mediaId: uuid('media_id')
      .primaryKey()
      .references(() => media.id, { onDelete: 'cascade' }),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: at('lease_until'),
    /** A fresh token per claim: only the claim holding it may settle the row (recordScan), so a worker whose lease ran out changes nothing. */
    claimToken: uuid('claim_token'),
    lastError: text('last_error'),
  },
  (t) => [index('media_scans_lease').on(t.leaseUntil)],
);
