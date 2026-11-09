import type { Uuid } from '@peblish/schema/ids';
import { db, type Queryable } from '../db/read.ts';

// Owned by lane E2, which replaces the body and keeps the signature. GW3's stub answers 0, so
// the shell's Inbox badge is wired before notifications exist.

/** The viewer's unread notices, at most unreadCap (view.ts); 0 when signed out (`viewerId` null), with no query. */
export async function unreadCount(_viewerId: Uuid | null, _q: Queryable = db()): Promise<number> {
  return 0;
}
