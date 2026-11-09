import type { Uuid } from '@peblish/schema/ids';
import { db, type Queryable } from '../db/read.ts';

// Owned by lane REP, which replaces the body and keeps the signature. GW3's stub answers 0, so
// the shell's Moderation queue badge is wired before reports exist.

/** Who asks: the shell passes the signed-in person with their site role (admin only with two-factor on). */
export type ReportViewer = { actorId: Uuid; siteRole: 'user' | 'admin' };

/** The open report groups the viewer may act on: every group for an admin, their communities' moderator groups for a moderator. */
export async function openReportCount(_viewer: ReportViewer, _q: Queryable = db()): Promise<number> {
  return 0;
}
