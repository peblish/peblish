import { describe, expect, it } from 'vitest';
import { diff } from '../test/diff.ts';
import { activityToWire, announceJson } from './activity.ts';
import { actorFromWire } from './actor.ts';
import { postFromPage, postToPage } from './content.ts';
import { fromWire, toWire } from './document.ts';
import { MappingError } from './json.ts';
import type { PostRecord } from './records.ts';
import { LEMMY_CONTEXT, PUBLIC } from './vocabulary.ts';

const community = 'https://feddit.test/ap/c.news';
const post: PostRecord = {
  apId: 'https://feddit.test/ap/post/1',
  authorApId: 'https://feddit.test/ap/u.alice',
  communityApId: community,
  title: 'Hallo',
  url: null,
  bodyMd: 'Hallo **Welt**',
  contentHtml: '<p>Hallo <strong>Welt</strong></p>',
  language: 'de',
  sensitive: false,
  locked: null,
  featuredCommunity: null,
  publishedAt: new Date('2026-11-08T00:00:00.000Z'),
  editedAt: null,
  raw: null,
};

describe('outbound mapping', () => {
  it('sends the Lemmy vocabulary on every Page and the Public IRI in to', () => {
    expect(postToPage(post)).toMatchObject({
      to: [community, PUBLIC],
      cc: [],
      commentsEnabled: true,
      stickied: false,
      sensitive: false,
      language: { identifier: 'de', name: 'Deutsch' },
      attachment: [],
      audience: community,
    });
    expect(postToPage({ ...post, locked: true, featuredCommunity: true })).toMatchObject({ commentsEnabled: false, stickied: true });
    const envelope = { id: 'https://feddit.test/ap/activity/2', actorApId: post.authorApId, communityApId: community, raw: null };
    expect(activityToWire({ ...envelope, type: 'Delete', objectApId: post.apId, reason: null })).toMatchObject({
      to: [PUBLIC],
      cc: [community],
    });
    expect(activityToWire({ ...envelope, type: 'Create', object: { type: 'Page', post } })).toMatchObject({
      to: [PUBLIC],
      cc: [community],
      audience: community,
    });
  });

  it("embeds another server's activity in an Announce untouched", () => {
    const inner = { id: 'https://lemmy.test/activities/like/1', type: 'Like', to: 'https://x.test/single' };
    const announce = announceJson('https://feddit.test/ap/activity/3', community, inner);
    expect(announce.object).toBe(inner);
    expect(announce).toMatchObject({ actor: community, to: [PUBLIC], cc: [`${community}/followers`] });
  });
});

describe('inbound mapping', () => {
  it('reads a Page without commentsEnabled or stickied as unknown, not as false', () => {
    const page = {
      type: 'Page',
      id: 'https://lemmy.test/post/1',
      attributedTo: 'https://lemmy.test/u/a',
      name: 'x',
      audience: 'https://lemmy.test/c/lab',
    };
    expect(postFromPage(page)).toMatchObject({ locked: null, featuredCommunity: null });
    expect(postFromPage({ ...page, commentsEnabled: false, stickied: true })).toMatchObject({ locked: true, featuredCommunity: true });
  });

  it('refuses what it cannot map with a MappingError that names the problem', () => {
    const page = { type: 'Page', id: 'https://x.test/p/1', attributedTo: 'https://x.test/u/a', name: 'x', to: [PUBLIC] };
    expect(() => postFromPage(page)).toThrow(new MappingError('Page https://x.test/p/1 names no community'));
    expect(() => actorFromWire({ type: 'Person', id: 'not a url', preferredUsername: 'a', inbox: 'https://x.test/inbox' })).toThrow(
      /actor: id must be a URL/,
    );
  });

  it('refuses activities nested past the depth bound instead of recursing into them', () => {
    const like = {
      type: 'Like',
      id: 'https://lemmy.test/activities/like/1',
      actor: 'https://lemmy.test/u/a',
      object: 'https://lemmy.test/post/1',
    };
    const undo = (object: object, index: number) => ({
      type: 'Undo',
      id: `https://lemmy.test/activities/undo/${index}`,
      actor: like.actor,
      object,
    });
    const announce = (object: object) => ({
      type: 'Announce',
      id: 'https://lemmy.test/activities/announce/1',
      actor: 'https://lemmy.test/c/lab',
      object,
    });
    expect(fromWire(announce(undo(like, 1)))).toMatchObject({ kind: 'activity', activity: { type: 'Announce', object: { type: 'Undo' } } });
    expect(fromWire(announce(undo(undo(like, 1), 2)))).toMatchObject({ kind: 'activity' });
    expect(() => fromWire(announce(undo(undo(undo(like, 1), 2), 3)))).toThrow(new MappingError('activities nest more than 3 deep'));
    let deep: object = like;
    for (let index = 0; index < 100_000; index++) deep = undo(deep, index);
    expect(() => fromWire(deep)).toThrow(MappingError);
  });
});

describe('actor edits', () => {
  it("maps Lemmy's Update of a Group to the community's record and back unchanged", () => {
    const id = 'https://lemmy.lab.test/c/lab';
    const group = {
      type: 'Group',
      id,
      preferredUsername: 'lab',
      inbox: `${id}/inbox`,
      followers: `${id}/followers`,
      publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n' },
      name: 'Lemmy lab',
      sensitive: false,
      attributedTo: `${id}/moderators`,
      postingRestrictedToMods: false,
      outbox: `${id}/outbox`,
      endpoints: { sharedInbox: 'https://lemmy.lab.test/inbox' },
      featured: `${id}/featured`,
      language: [],
      published: '2026-11-08T02:25:32.170964Z',
    };
    const update = {
      '@context': LEMMY_CONTEXT,
      id: 'https://lemmy.lab.test/activities/update/1',
      type: 'Update',
      actor: 'https://lemmy.lab.test/u/lemmyadmin',
      to: [PUBLIC],
      object: group,
      cc: [id],
      audience: id,
    };
    const mapped = fromWire(update);
    expect(mapped).toMatchObject({
      kind: 'activity',
      activity: { type: 'Update', object: { type: 'Actor', actor: { kind: 'Group', name: 'lab' } } },
    });
    expect(diff(update, toWire(mapped))).toEqual([]);
  });
});
