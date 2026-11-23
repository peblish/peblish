import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { markAllNotificationsRead, markNotification, undoMarkAllRead } from './mutations.ts';

/** A person marks one notice read or unread, for web: authorize, then write. A refusal comes back as a result. */
export async function markNotificationAs(principal: Principal, notificationId: Uuid, read: boolean): Promise<Result<{ changed: boolean }>> {
  const decision = await authorize('notification.read', principal, { notificationId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => markNotification(decision.grant, { read }));
}

/** A person marks every notice of theirs read, for web; `batch` is what undoes it (undoMarkAllReadAs). */
export async function markAllNotificationsReadAs(principal: Principal): Promise<Result<{ count: number; batch: string | null }>> {
  if (principal.kind === 'anonymous') return { ok: false, reason: 'auth.required' };
  const decision = await authorize('notification.read_all', principal, { recipientId: principal.actorId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => markAllNotificationsRead(decision.grant, undefined));
}

/** A person undoes their Mark all read `batch`: exactly the notices it marked read and still read from it are unread again. */
export async function undoMarkAllReadAs(principal: Principal, batch: string): Promise<Result<{ count: number }>> {
  if (principal.kind === 'anonymous') return { ok: false, reason: 'auth.required' };
  const decision = await authorize('notification.undo_read_all', principal, { recipientId: principal.actorId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => undoMarkAllRead(decision.grant, { batch }));
}
