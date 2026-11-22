import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { hideNsfw, showNsfw } from '../communities/gate.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { seedComment, seedModerationWorld, seedPost } from '../testing/seed-az.ts';
import { localUser, seedActor } from '../testing/seed.ts';
import { createReportAs } from './actions.ts';
import { readReportForm, readSentReport } from './form.ts';
import type { ReportTarget } from './types.ts';

beforeEach(truncateAll);

describe('the report form quotes only what the post page would show this viewer', () => {
  test('a post and a comment in an NSFW community, for an undeclared and a declared viewer', async () => {
    const w = await seedModerationWorld();
    const community = w.communities.local.live;
    await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, community.id));
    const post = await seedPost(w.instances.local, community, w.people.author, { title: 'Plain title' });
    const comment = await seedComment(w.instances.local, post, w.people.author, { bodyMd: 'Plain words' });
    const quote = async (target: ReportTarget, nsfw = hideNsfw) => {
      const form = await readReportForm(localUser(w.people.user.id), target, db(), nsfw);
      if (!form.ok) throw new Error(form.reason);
      return form.quote;
    };
    const onPost: ReportTarget = { kind: 'post', id: post.id };
    const onComment: ReportTarget = { kind: 'comment', id: comment.id };
    // undeclared: the age gate, whatever the browser chose
    expect(await quote(onPost, showNsfw)).toBeNull();
    expect(await quote(onComment, showNsfw)).toBeNull();
    await writer().insert(ageDeclarations).values({ actorId: w.people.user.id });
    // declared with Hide NSFW on: still withheld
    expect(await quote(onPost)).toBeNull();
    expect(await quote(onComment)).toBeNull();
    // declared and showing NSFW: quoted
    expect(await quote(onPost, showNsfw)).toBe('Plain title');
    expect(await quote(onComment, showNsfw)).toBe('Plain words');
    // the NSFL flag gates the same way
    await writer().update(actors).set({ sensitive: false, nsfl: true }).where(eq(actors.id, community.id));
    expect(await quote(onPost)).toBeNull();
  });
});

describe("the quote follows the comment's own visibility for this viewer", () => {
  test('a comment by someone the reporter blocks is not quoted, though its author line stays as the thread draws it', async () => {
    const w = await seedModerationWorld();
    const post = await seedPost(w.instances.local, w.communities.local.live, w.people.author, { title: 'Plain title' });
    const comment = await seedComment(w.instances.local, post, w.people.author, { bodyMd: 'Hidden words' });
    const form = async () => {
      const read = await readReportForm(localUser(w.people.user.id), { kind: 'comment', id: comment.id });
      if (!read.ok) throw new Error(read.reason);
      return [read.quote, read.about.handle];
    };
    expect(await form()).toEqual(['Hidden words', w.people.author.name]);
    await seedBlock(w.people.user, w.people.author);
    expect(await form()).toEqual([null, w.people.author.name]);
  });
});

describe('a forwarded report names every host it goes to', () => {
  test('the form lists the community host and the author host; the receipt drops the anonymity promise only when forwarded', async () => {
    const w = await seedModerationWorld();
    // The outbound Flag goes to inboxes, shared first: give every remote actor one.
    await writer()
      .update(actors)
      .set({ inboxUrl: sql`'https://' || split_part(${actors.apId}, '/', 3) || '/inbox'` })
      .where(eq(actors.local, false));
    const stranger = await seedActor(w.instances.other, 'Person', 'stranger', { inboxUrl: 'https://other.test/u/stranger/inbox' });
    const both = await seedPost(w.instances.lemmy, w.communities.remote.live, stranger, { title: 'Two hosts' });
    const authorOnly = await seedPost(w.instances.local, w.communities.local.live, stranger, { title: 'Author host' });
    const user = localUser(w.people.user.id);
    const hosts = async (id: string, as = user) => {
      const form = await readReportForm(as, { kind: 'post', id });
      if (!form.ok) throw new Error(form.reason);
      return form.hosts;
    };
    expect(await hosts(both.id)).toEqual(['lemmy.test', 'other.test']);
    expect(await hosts(authorOnly.id)).toEqual(['other.test']);
    expect(await hosts(w.subjects.remote.normal.postId)).toEqual(['lemmy.test']);
    expect(await hosts(w.subjects.local.normal.postId)).toEqual([]);
    const sent = await createReportAs(user, { target: { kind: 'post', id: both.id }, category: 'spam', forward: true, details: '' });
    const kept = await createReportAs(user, { target: { kind: 'post', id: authorOnly.id }, category: 'spam', forward: false, details: '' });
    if (!sent.ok || !kept.ok) throw new Error('not filed');
    expect(await readSentReport(user, sent.number)).toMatchObject({ forwardedTo: ['lemmy.test', 'other.test'] });
    expect(await readSentReport(user, kept.number)).toMatchObject({ forwardedTo: [] });

    // The delivery worker skips a blocked peer at send time, and an actor without an inbox gets nothing: neither is named.
    await writer().insert(peerControls).values({ instanceId: w.instances.other.id, blocked: true });
    const other = localUser((await seedActor(w.instances.local, 'Person', 'other_reporter')).id);
    expect(await hosts(both.id, other)).toEqual(['lemmy.test']);
    expect(await hosts(authorOnly.id, other)).toEqual([]);
    const noInbox = await seedActor(w.instances.lemmy, 'Person', 'no_inbox');
    expect(await hosts((await seedPost(w.instances.local, w.communities.local.live, noInbox, { title: 'No inbox' })).id)).toEqual([]);
  });
});

describe('the receipt names what was forwarded when the report was filed', () => {
  test('blocking every recipient afterwards does not bring back the anonymity promise, and unblocking adds nobody', async () => {
    const w = await seedModerationWorld();
    await writer()
      .update(actors)
      .set({ inboxUrl: sql`'https://' || split_part(${actors.apId}, '/', 3) || '/inbox'` })
      .where(eq(actors.local, false));
    const stranger = await seedActor(w.instances.other, 'Person', 'stranger', { inboxUrl: 'https://other.test/u/stranger/inbox' });
    const both = await seedPost(w.instances.lemmy, w.communities.remote.live, stranger, { title: 'Two hosts' });
    const user = localUser(w.people.user.id);
    const sent = await createReportAs(user, { target: { kind: 'post', id: both.id }, category: 'spam', forward: true, details: '' });
    if (!sent.ok) throw new Error(sent.reason);
    await writer()
      .insert(peerControls)
      .values([
        { instanceId: w.instances.lemmy.id, blocked: true },
        { instanceId: w.instances.other.id, blocked: true },
      ]);
    expect(await readSentReport(user, sent.number)).toMatchObject({ forwardedTo: ['lemmy.test', 'other.test'] });

    // Filed while other.test was blocked, then other.test unblocked: the receipt still names lemmy.test alone.
    await writer().delete(peerControls).where(eq(peerControls.instanceId, w.instances.lemmy.id));
    const second = await seedPost(w.instances.lemmy, w.communities.remote.live, stranger, { title: 'Later' });
    const later = await createReportAs(user, { target: { kind: 'post', id: second.id }, category: 'spam', forward: true, details: '' });
    if (!later.ok) throw new Error(later.reason);
    await writer().delete(peerControls).where(eq(peerControls.instanceId, w.instances.other.id));
    expect(await readSentReport(user, later.number)).toMatchObject({ forwardedTo: ['lemmy.test'] });
  });
});

describe('the report form and its receipt name the author only where the post page would', () => {
  test('gated content: the community and not the author for someone without a 16+ declaration, who can still report it', async () => {
    const w = await seedModerationWorld();
    const community = w.communities.local.live;
    await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, community.id));
    const post = await seedPost(w.instances.local, community, w.people.author, { title: 'Plain title' });
    const comment = await seedComment(w.instances.local, post, w.people.author, { bodyMd: 'Plain words' });
    const user = localUser(w.people.user.id);
    const targets: ReportTarget[] = [
      { kind: 'post', id: post.id },
      { kind: 'comment', id: comment.id },
    ];
    const about = async (target: ReportTarget, nsfw = hideNsfw) => {
      const form = await readReportForm(user, target, db(), nsfw);
      if (!form.ok) throw new Error(form.reason);
      return form.about;
    };
    for (const target of targets) {
      // The browser's choice does not open the age gate.
      for (const nsfw of [hideNsfw, showNsfw])
        expect(await about(target, nsfw)).toEqual({ kind: target.kind, handle: null, community: community.name });
    }
    // Someone else files one, so the form above stays open to `user`.
    const reporter = localUser((await seedActor(w.instances.local, 'Person', 'reporter')).id);
    const sent = await createReportAs(reporter, {
      target: { kind: 'comment', id: comment.id },
      category: 'spam',
      forward: false,
      details: '',
    });
    if (!sent.ok) throw new Error(sent.reason);
    expect((await readSentReport(reporter, sent.number))?.blockHandle).toBeNull();

    // Declared: named as before, Hide NSFW on or not (a prompt the page lets them pass).
    await writer()
      .insert(ageDeclarations)
      .values([{ actorId: w.people.user.id }, { actorId: reporter.actorId }]);
    for (const target of targets) {
      for (const nsfw of [hideNsfw, showNsfw]) expect((await about(target, nsfw)).handle).toBe('author');
    }
    expect((await readSentReport(reporter, sent.number))?.blockHandle).toBe('author');
  });

  test('the receipt drops the author once the post page would: a removed or deleted comment, a removed or deleted post', async () => {
    const w = await seedModerationWorld();
    const community = w.communities.local.live;
    const post = await seedPost(w.instances.local, community, w.people.author, { title: 'Plain title' });
    const comment = await seedComment(w.instances.local, post, w.people.author, { bodyMd: 'Plain words' });
    const file = async (reporter: { id: string }, target: ReportTarget) => {
      const sent = await createReportAs(localUser(reporter.id), { target, category: 'spam', forward: false, details: '' });
      if (!sent.ok) throw new Error(sent.reason);
      return async () => (await readSentReport(localUser(reporter.id), sent.number))?.blockHandle;
    };
    const onComment = await file(w.people.user, { kind: 'comment', id: comment.id });
    const onPost = await file(w.people.user, { kind: 'post', id: post.id });
    const byModerator = await file(w.people.moderator, { kind: 'post', id: post.id });
    const onCommentByModerator = await file(w.people.moderator, { kind: 'comment', id: comment.id });
    expect([await onComment(), await onPost(), await byModerator()]).toEqual(['author', 'author', 'author']);

    // A removed comment is a tombstone without its author in the thread, but for the moderators.
    await writer().update(comments).set({ removedAt: new Date() }).where(eq(comments.id, comment.id));
    expect([await onComment(), await onCommentByModerator()]).toEqual([null, 'author']);
    await writer().update(comments).set({ removedAt: null }).where(eq(comments.id, comment.id));

    await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, comment.id));
    expect(await onComment()).toBeNull();
    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, post.id));
    expect(await onPost()).toBeNull();
    // The community's moderators are told, as the post page tells them.
    expect(await byModerator()).toBe('author');
    await writer().update(posts).set({ removedAt: null, deletedAt: new Date() }).where(eq(posts.id, post.id));
    expect(await onPost()).toBeNull();
  });
});
