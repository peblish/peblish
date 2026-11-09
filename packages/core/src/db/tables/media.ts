import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id } from '../columns.ts';
import { actors } from './actors.ts';

const kindValues = ['upload', 'remote', 'thumbnail'] as const;
const scanStateValues = ['pending', 'clean', 'quarantined', 'blocked', 'failed'] as const;

/**
 * Stored media: uploads, remote originals recorded by reference, and generated thumbnails.
 * Nothing is served until scan_state is 'clean' (lane SAFE owns the state machine).
 */
export const media = pgTable(
  'media',
  {
    id: id(),
    ownerId: uuid('owner_id').references(() => actors.id),
    kind: text('kind', { enum: kindValues }).notNull(),
    /** Object key in the bucket; null for remote media that is proxied, not stored. */
    storageKey: text('storage_key').unique(),
    remoteUrl: text('remote_url'),
    mimeType: text('mime_type'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    width: integer('width'),
    height: integer('height'),
    sha256: text('sha256'),
    altText: text('alt_text'),
    scanState: text('scan_state', { enum: scanStateValues }).notNull().default('pending'),
    scannedAt: at('scanned_at'),
    deletedAt: at('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    enumCheck('media_kind', t.kind, kindValues),
    enumCheck('media_scan_state', t.scanState, scanStateValues),
    index('media_scan_pending')
      .on(t.createdAt)
      .where(sql`${t.scanState} = 'pending'`),
    index('media_sha256').on(t.sha256),
    /** The evidence purge pass (lane SAFE) reads stored bytes of blocked and failed rows every minute. */
    index('media_purge')
      .on(t.scanState)
      .where(sql`${t.storageKey} is not null and ${t.scanState} in ('blocked', 'failed')`),
  ],
);
