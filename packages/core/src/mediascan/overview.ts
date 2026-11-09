import type { Uuid } from '@peblish/schema/ids';
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { media } from '../db/tables/media.ts';
import { mediaEvidence, type HoldAuthority } from '../evidence/tables.ts';
import { readSetting } from '../settings/read.ts';
import { scanConfig } from './config.ts';
import { heldSql, holdKeepsBytes } from './purge.ts';
import { mediaBlocklist, mediaScans } from './tables.ts';
import { mediaUrl } from './usage.ts';

// Owned by lane SAFE. What the admin Media tab shows: facts and counts, never an image, and no
// link to one. Dates are ISO strings so the page's server function can hand them to the browser.

export type Person = { handle: string } | null;

export type QuarantineRow = {
  mediaId: Uuid;
  evidenceId: Uuid;
  sha256: string | null;
  mimeType: string | null;
  byteSize: number | null;
  uploader: Person;
  /** 'Blocklist' or the provider's name. */
  source: string;
  classification: string;
  matchType: 'exact' | 'near' | null;
  uploadedAt: string;
  quarantinedAt: string;
  /** Posts that still show the image. */
  livePosts: { id: Uuid; title: string }[];
  holdAuthority: HoldAuthority | null;
  holdReference: string | null;
  holdUntil: string | null;
  /** An AFP hold in force: it keeps the bytes and stops the automatic block. */
  bytesHeld: boolean;
  /** When the undecided window ends and the image is blocked, unless an AFP hold stands. */
  blocksAt: string;
};

export type FailedRow = { mediaId: Uuid; uploader: Person; at: string; reason: string };

export type HashRow = { id: Uuid; sha256: string; category: string; reason: string | null; addedAt: string; addedBy: Person };

export type EvidenceRow = {
  evidenceId: Uuid;
  mediaId: Uuid;
  manifestSha256: string;
  status: 'open' | 'confirmed' | 'released';
  decidedAt: string | null;
  decidedBy: Person;
  /**
   * The image's one stored object now, whatever this incident's status (a later incident may have
   * moved it on): purged: gone; kept: stored and served, the image is clean; held: kept by an AFP
   * hold in force on any of its incidents; waiting: still stored, for a decision or the purge.
   */
  bytes: 'held' | 'purged' | 'kept' | 'waiting';
  holdAuthority: HoldAuthority | null;
  holdReference: string | null;
  holdUntil: string | null;
  retainUntil: string | null;
  /** The manifest as pretty JSON text: facts about the image, never the image. */
  manifest: string;
};

export type MediaOverview = {
  scanner: { kind: 'provider' | 'local-only' | 'none'; providers: string[] };
  uploadsEnabled: boolean;
  remoteMediaEnabled: boolean;
  undecidedPurgeDays: number;
  counts: { quarantined: number; failed24h: number; blocked: number; hashes: number; evidence: number };
  quarantine: QuarantineRow[];
  failed: FailedRow[];
  hashes: HashRow[];
  evidence: EvidenceRow[];
};

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** `@name@host` for an actor id, as one lookup for a set of ids. */
async function people(ids: (Uuid | null)[]): Promise<Map<Uuid, { handle: string }>> {
  const wanted = [...new Set(ids.filter((id): id is Uuid => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await db()
    .select({ id: actors.id, name: actors.name, domain: instances.domain })
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(inArray(actors.id, wanted));
  return new Map(rows.map((row) => [row.id, { handle: `@${row.name}@${row.domain}` }]));
}

/** The live posts that show each of `ids`, from one scan of posts for local media URLs. */
async function livePosts(ids: Uuid[]): Promise<Map<Uuid, { id: Uuid; title: string }[]>> {
  const found = new Map<Uuid, { id: Uuid; title: string }[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return found;
  const prefix = mediaUrl((await localInstance(db())).origin, '');
  const rows = await db()
    .select({ id: posts.id, title: posts.title, url: posts.url, thumbnailUrl: posts.thumbnailUrl })
    .from(posts)
    .where(
      and(
        or(sql`${posts.url} like ${`${prefix}%`}`, sql`${posts.thumbnailUrl} like ${`${prefix}%`}`),
        isNull(posts.removedAt),
        isNull(posts.deletedAt),
      ),
    );
  for (const row of rows)
    for (const url of [row.url, row.thumbnailUrl]) {
      const id = url?.startsWith(prefix) ? url.slice(prefix.length) : null;
      if (id && found.has(id)) found.get(id)!.push({ id: row.id, title: row.title });
    }
  return found;
}

export async function mediaOverview(now = new Date()): Promise<MediaOverview> {
  const config = scanConfig();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [quarantined] = await db().select({ n: count() }).from(media).where(eq(media.scanState, 'quarantined'));
  const [failed24h] = await db()
    .select({ n: count() })
    .from(media)
    .where(and(eq(media.scanState, 'failed'), gt(media.scannedAt, dayAgo)));
  const [blocked] = await db().select({ n: count() }).from(media).where(eq(media.scanState, 'blocked'));
  const [hashCount] = await db().select({ n: count() }).from(mediaBlocklist);
  const [evidenceCount] = await db().select({ n: count() }).from(mediaEvidence);

  const open = await db()
    .select({ evidence: mediaEvidence, media })
    .from(mediaEvidence)
    .innerJoin(media, eq(media.id, mediaEvidence.mediaId))
    .where(and(eq(media.scanState, 'quarantined'), eq(mediaEvidence.status, 'open')))
    .orderBy(desc(mediaEvidence.createdAt))
    .limit(100);
  const failedRows = await db()
    .select({ id: media.id, ownerId: media.ownerId, at: media.scannedAt, createdAt: media.createdAt, error: mediaScans.lastError })
    .from(media)
    .leftJoin(mediaScans, eq(mediaScans.mediaId, media.id))
    .where(eq(media.scanState, 'failed'))
    .orderBy(desc(media.scannedAt))
    .limit(20);
  const hashRows = await db().select().from(mediaBlocklist).orderBy(desc(mediaBlocklist.createdAt)).limit(500);
  const evidenceRows = await db()
    .select({
      evidence: mediaEvidence,
      storageKey: media.storageKey,
      scanState: media.scanState,
      held: heldSql(media.id, now).mapWith(Boolean),
    })
    .from(mediaEvidence)
    .innerJoin(media, eq(media.id, mediaEvidence.mediaId))
    .where(or(ne(mediaEvidence.status, 'open'), isNotNull(mediaEvidence.holdUntil)))
    .orderBy(desc(mediaEvidence.createdAt))
    .limit(50);

  const who = await people([
    ...open.map((row) => row.media.ownerId),
    ...failedRows.map((row) => row.ownerId),
    ...hashRows.map((row) => row.addedBy),
    ...evidenceRows.map((row) => row.evidence.decidedBy),
  ]);
  const postsByMedia = await livePosts(open.map((row) => row.media.id));
  const person = (id: Uuid | null): Person => (id ? (who.get(id) ?? null) : null);

  return {
    scanner: {
      kind: config.arachnid ? 'provider' : config.localOnly ? 'local-only' : 'none',
      providers: config.arachnid ? ['arachnid'] : [],
    },
    uploadsEnabled: await readSetting('uploads.enabled'),
    remoteMediaEnabled: await readSetting('remote_media.enabled'),
    undecidedPurgeDays: config.undecidedPurgeDays,
    counts: {
      quarantined: quarantined?.n ?? 0,
      failed24h: failed24h?.n ?? 0,
      blocked: blocked?.n ?? 0,
      hashes: hashCount?.n ?? 0,
      evidence: evidenceCount?.n ?? 0,
    },
    quarantine: open.map(({ evidence, media: row }) => ({
      mediaId: row.id,
      evidenceId: evidence.id,
      sha256: row.sha256,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      uploader: person(row.ownerId),
      source:
        evidence.source === 'list'
          ? 'Blocklist'
          : ((evidence.manifest as { verdict?: { provider?: string } }).verdict?.provider ?? 'provider'),
      classification: evidence.classification,
      matchType: evidence.matchType === 'exact' || evidence.matchType === 'near' ? evidence.matchType : null,
      uploadedAt: row.createdAt.toISOString(),
      quarantinedAt: evidence.createdAt.toISOString(),
      livePosts: postsByMedia.get(row.id) ?? [],
      holdAuthority: evidence.holdAuthority,
      holdReference: evidence.holdReference,
      holdUntil: iso(evidence.holdUntil),
      bytesHeld: holdKeepsBytes(evidence, now),
      blocksAt: new Date(evidence.createdAt.getTime() + config.undecidedPurgeDays * 86_400_000).toISOString(),
    })),
    failed: failedRows.map((row) => ({
      mediaId: row.id,
      uploader: person(row.ownerId),
      at: (row.at ?? row.createdAt).toISOString(),
      reason: row.error ?? '',
    })),
    hashes: hashRows.map((row) => ({
      id: row.id,
      sha256: row.value,
      category: row.category,
      reason: row.reason,
      addedAt: row.createdAt.toISOString(),
      addedBy: person(row.addedBy),
    })),
    evidence: evidenceRows.map(({ evidence, storageKey, scanState, held }) => ({
      evidenceId: evidence.id,
      mediaId: evidence.mediaId,
      manifestSha256: evidence.manifestSha256,
      status: evidence.status,
      decidedAt: iso(evidence.decidedAt),
      decidedBy: person(evidence.decidedBy),
      bytes: storageKey === null ? 'purged' : scanState === 'clean' ? 'kept' : held ? 'held' : 'waiting',
      holdAuthority: evidence.holdAuthority,
      holdReference: evidence.holdReference,
      holdUntil: iso(evidence.holdUntil),
      retainUntil: iso(evidence.retainUntil),
      manifest: JSON.stringify(evidence.manifest, null, 2),
    })),
  };
}
