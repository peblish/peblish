import type { Uuid } from '@peblish/schema/ids';
import type { WriteTx } from '../db/write.ts';
import { mediaEvidenceLog } from './tables.ts';

/** Appends a line to an evidence row's history; the table is insert-only. `actorId` is null for the instance acting as itself. */
export async function logEvidence(db: WriteTx, line: { evidenceId: Uuid; actorId: Uuid | null; event: string; note?: string | null }) {
  await db
    .insert(mediaEvidenceLog)
    .values({ evidenceId: line.evidenceId, actorId: line.actorId, event: line.event, note: line.note ?? null });
}
