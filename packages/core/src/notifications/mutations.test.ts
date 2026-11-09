import type { Principal } from '@peblish/schema/authz';
import { parseEvent } from '@peblish/schema/events';
import { uuidv7 } from 'uuidv7';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { truncateAll } from '../testing/db.ts';
import { writer } from '../db/write.ts';
import { actors } from '../db/tables/actors.ts';
import { eq } from 'drizzle-orm';
import { grantFor, outboxEvents } from '../testing/seed-az.ts';
import { noticeCount, noticesOf, sameTransactionAsNotice, seedInboxWorld, seedNotice } from '../testing/seed-e2.ts';
import { localUser } from '../testing/seed.ts';
import { createNotification, markAllNotificationsRead, markNotification, purgeNotifications } from './mutations.ts';

beforeEach(truncateAll);

const none = { actorId: null, communityId: null, postId: null, commentId: null, modlogId: null };

async function setup() {
  const world = await seedInboxWorld();
  const owner = localUser(world.people.author.id);
  const other = localUser(world.people.reader.id);
  const remote: Principal = { kind: 'remote', actorId: world.people.remoteAuthor.id, announcedBy: null };
  const scheduled = await systemPrincipal(db(), 'scheduled');
  const imported = await systemPrincipal(db(), 'import');
  const notice = await seedNotice({ recipientId: world.people.author.id, kind: 'reply', refId: uuidv7() });
  return { world, owner, other, remote, scheduled, imported, notice };
}

const events = async () => (await outboxEvents()).map(parseEvent);

describe('policies', () => {
  test('notification.create is the scheduled job writing for a live local person', async () => {
    const { world, owner, remote, scheduled, imported } = await setup();
    const subject = { recipientId: world.people.reader.id, kind: 'mention', refId: uuidv7() } as const;
    const ask = async (principal: Principal, over: Partial<typeof subject> = {}) => {
      const decision = await authorize('notification.create', principal, { ...subject, ...over });
      return decision.ok ? 'ok' : decision.reason;
    };
    expect(await ask({ kind: 'anonymous' })).toBe('auth.required');
    expect(await ask(owner)).toBe('auth.required');
    expect(await ask(remote)).toBe('auth.required');
    expect(await ask(imported)).toBe('auth.required');
    expect(await ask(scheduled)).toBe('ok');
    expect(await ask(scheduled, { recipientId: world.people.remoteAuthor.id })).toBe('target.not_found');
    expect(await ask(scheduled, { recipientId: world.communities.open.id })).toBe('target.not_found');
    expect(await ask(scheduled, { recipientId: uuidv7() })).toBe('target.not_found');
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, world.people.reader.id));
    expect(await ask(scheduled)).toBe('target.deleted');
  });

  test('notification.read is the local owner of the notice', async () => {
    const { owner, other, remote, scheduled, notice } = await setup();
    const ask = async (principal: Principal, notificationId: string = notice.id) => {
      const decision = await authorize('notification.read', principal, { notificationId });
      return decision.ok ? 'ok' : decision.reason;
    };
    expect(await ask({ kind: 'anonymous' })).toBe('auth.required');
    expect(await ask(remote)).toBe('auth.required');
    expect(await ask(scheduled)).toBe('auth.required');
    expect(await ask(other)).toBe('notification.not_yours');
    expect(await ask(owner, uuidv7())).toBe('target.not_found');
    expect(await ask(owner)).toBe('ok');
  });

  test('notification.read_all and notification.purge', async () => {
    const { world, owner, other, remote, scheduled, imported } = await setup();
    const readAll = async (principal: Principal, recipientId = world.people.author.id) => {
      const decision = await authorize('notification.read_all', principal, { recipientId });
      return decision.ok ? 'ok' : decision.reason;
    };
    expect(await readAll({ kind: 'anonymous' })).toBe('auth.required');
    expect(await readAll(remote)).toBe('auth.required');
    expect(await readAll(scheduled)).toBe('auth.required');
    expect(await readAll(other)).toBe('notification.not_yours');
    expect(await readAll(owner)).toBe('ok');

    const purge = async (principal: Principal) => {
      const decision = await authorize('notification.purge', principal, { recipientId: world.people.author.id });
      return decision.ok ? 'ok' : decision.reason;
    };
    expect(await purge(owner)).toBe('auth.required');
    expect(await purge(remote)).toBe('auth.required');
    expect(await purge(imported)).toBe('auth.required');
    expect(await purge(scheduled)).toBe('ok');
  });
});

describe('createNotification', () => {
  test('writes the row and notification.created in one transaction, and a repeat writes neither', async () => {
    const { world, scheduled } = await setup();
    const subject = { recipientId: world.people.reader.id, kind: 'mention', refId: uuidv7() } as const;
    const grant = await grantFor('notification.create', scheduled, subject);

    const id = await createNotification(grant, { ...none, actorId: world.people.author.id });
    expect(id).toEqual(expect.any(String));
    const [row] = await noticesOf(world.people.reader.id);
    expect(row).toMatchObject({ id, kind: 'mention', refId: subject.refId, actorId: world.people.author.id, readAt: null });
    expect(await sameTransactionAsNotice(id!, 'notification.created')).toBe(true);

    expect(await createNotification(grant, none)).toBeNull();
    expect(await noticeCount()).toBe(2); // the setup's notice and this one
    expect((await events()).filter((e) => e.type === 'notification.created')).toEqual([
      { type: 'notification.created', v: 1, notificationId: id, recipientId: world.people.reader.id, kind: 'mention' },
    ]);
  });
});

describe('marking read', () => {
  test('marks the owner’s notice read and unread, and emits only when something changed', async () => {
    const { world, owner, notice } = await setup();
    const grant = await grantFor('notification.read', owner, { notificationId: notice.id });

    expect(await markNotification(grant, { read: true })).toEqual({ changed: true });
    expect((await noticesOf(world.people.author.id))[0]?.readAt).not.toBeNull();
    expect(await markNotification(grant, { read: true })).toEqual({ changed: false });
    expect(await markNotification(grant, { read: false })).toEqual({ changed: true });
    expect((await noticesOf(world.people.author.id))[0]?.readAt).toBeNull();

    const reads = (await events()).filter((e) => e.type === 'notification.read');
    expect(reads).toEqual([
      { type: 'notification.read', v: 1, recipientId: world.people.author.id, notificationId: notice.id, read: true, count: 1 },
      { type: 'notification.read', v: 1, recipientId: world.people.author.id, notificationId: notice.id, read: false, count: 1 },
    ]);
  });

  test('read_all touches only the caller’s unread notices', async () => {
    const { world, owner } = await setup();
    await seedNotice({ recipientId: world.people.author.id, kind: 'mention', refId: uuidv7() });
    await seedNotice({ recipientId: world.people.author.id, kind: 'mention', refId: uuidv7(), readAt: new Date() });
    const theirs = await seedNotice({ recipientId: world.people.reader.id, kind: 'reply', refId: uuidv7() });

    const grant = await grantFor('notification.read_all', owner, { recipientId: world.people.author.id });
    expect(await markAllNotificationsRead(grant, undefined)).toEqual({ count: 2 });
    expect((await noticesOf(world.people.author.id)).every((row) => row.readAt)).toBe(true);
    expect((await noticesOf(world.people.reader.id))[0]).toMatchObject({ id: theirs.id, readAt: null });
    expect(await markAllNotificationsRead(grant, undefined)).toEqual({ count: 0 });
    expect((await events()).filter((e) => e.type === 'notification.read')).toEqual([
      { type: 'notification.read', v: 1, recipientId: world.people.author.id, notificationId: null, read: true, count: 2 },
    ]);
  });

  test('a person cannot mark another’s notice, and the notice stays unread', async () => {
    const { world, other, notice } = await setup();
    const decision = await authorize('notification.read', other, { notificationId: notice.id });
    expect(decision).toEqual({ ok: false, reason: 'notification.not_yours' });
    expect((await noticesOf(world.people.author.id))[0]?.readAt).toBeNull();
  });
});

describe('purgeNotifications', () => {
  test('removes only that person’s notices', async () => {
    const { world, scheduled } = await setup();
    await seedNotice({ recipientId: world.people.reader.id, kind: 'reply', refId: uuidv7() });
    const grant = await grantFor('notification.purge', scheduled, { recipientId: world.people.author.id });
    expect(await purgeNotifications(grant, undefined)).toEqual({ count: 1 });
    expect(await noticesOf(world.people.author.id)).toEqual([]);
    expect(await noticesOf(world.people.reader.id)).toHaveLength(1);
    expect((await events()).filter((e) => e.type === 'notification.purged')).toEqual([
      { type: 'notification.purged', v: 1, recipientId: world.people.author.id, count: 1 },
    ]);
    expect(await purgeNotifications(grant, undefined)).toEqual({ count: 0 });
  });
});
