import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { hideNsfw, showNsfw } from '../communities/gate.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
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
    expect(await readSentReport(w.people.user.id, sent.number)).toMatchObject({ forwardedTo: ['lemmy.test', 'other.test'] });
    expect(await readSentReport(w.people.user.id, kept.number)).toMatchObject({ forwardedTo: [] });

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
    expect(await readSentReport(w.people.user.id, sent.number)).toMatchObject({ forwardedTo: ['lemmy.test', 'other.test'] });

    // Filed while other.test was blocked, then other.test unblocked: the receipt still names lemmy.test alone.
    await writer().delete(peerControls).where(eq(peerControls.instanceId, w.instances.lemmy.id));
    const second = await seedPost(w.instances.lemmy, w.communities.remote.live, stranger, { title: 'Later' });
    const later = await createReportAs(user, { target: { kind: 'post', id: second.id }, category: 'spam', forward: true, details: '' });
    if (!later.ok) throw new Error(later.reason);
    await writer().delete(peerControls).where(eq(peerControls.instanceId, w.instances.other.id));
    expect(await readSentReport(w.people.user.id, later.number)).toMatchObject({ forwardedTo: ['lemmy.test'] });
  });
});
