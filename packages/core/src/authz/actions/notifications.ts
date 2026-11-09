import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { notifications } from '../../notifications/tables.ts';
import type { NotificationKind } from '../../notifications/view.ts';
import { allow, deny, forNoKeyUpdate, forShare, type PolicyRequest } from '../policy.ts';

// Owned by lane E2: the inbox. The instance writes notices (the notifications consumer runs as
// the `scheduled` system job); the person they belong to marks them read. No policy here
// rechecks: nothing writes the acting actor's row, and a notice for a person deleted in
// between is removed by the purge their deletion triggers. A write body updates or deletes
// the notice rows, so the policies read them FOR NO KEY UPDATE.

export const policies = {
  /** The consumer writes a notice for a live local person; a repeat of the same cause is the mutation's no-op. */
  'notification.create': async ({
    principal,
    subject,
    db,
    lock,
  }: PolicyRequest<{ recipientId: Uuid; kind: NotificationKind; refId: Uuid }>) => {
    if (principal.kind !== 'system' || principal.job !== 'scheduled') return deny('auth.required');
    const [recipient] = await forShare(
      db
        .select({ kind: actors.kind, local: actors.local, deletedAt: actors.deletedAt })
        .from(actors)
        .where(eq(actors.id, subject.recipientId)),
      lock,
    );
    if (!recipient || recipient.kind !== 'Person' || !recipient.local) return deny('target.not_found');
    if (recipient.deletedAt) return deny('target.deleted');
    return allow({ kind: 'system', actorId: principal.actorId, job: 'scheduled', ref: subject.refId });
  },

  /** A local person marks one of their own notices read or unread. */
  'notification.read': async ({ principal, subject, db, lock }: PolicyRequest<{ notificationId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const [row] = await forNoKeyUpdate(
      db.select({ recipientId: notifications.recipientId }).from(notifications).where(eq(notifications.id, subject.notificationId)),
      lock,
    );
    if (!row) return deny('target.not_found');
    if (row.recipientId !== principal.actorId) return deny('notification.not_yours');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },

  /** A local person marks all their own notices read. */
  'notification.read_all': async ({ principal, subject }: PolicyRequest<{ recipientId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    if (subject.recipientId !== principal.actorId) return deny('notification.not_yours');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },

  /** The consumer removes a deleted person's notices. */
  'notification.purge': async ({ principal, subject }: PolicyRequest<{ recipientId: Uuid }>) => {
    if (principal.kind !== 'system' || principal.job !== 'scheduled') return deny('auth.required');
    return allow({ kind: 'system', actorId: principal.actorId, job: 'scheduled', ref: subject.recipientId });
  },
};
