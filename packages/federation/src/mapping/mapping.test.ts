import { afterEach, describe, expect, it, vi } from 'vitest';
import { diff } from '../test/diff.ts';
import { activityToWire, announceJson } from './activity.ts';
import { actorFromWire } from './actor.ts';
import { IMAGE_TYPE, postFromPage, postToPage } from './content.ts';
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
  urlContentType: null,
  altText: null,
  thumbnailUrl: null,
  bodyMd: 'Hallo **Welt**',
  contentHtml: '<p>Hallo <strong>Welt</strong></p>',
  language: 'de',
  sensitive: false,
  nsfl: false,
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
      nsfl: false,
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
    // Lemmy sends neither nsfl nor search consent; peblish always does (test/vocabulary.ts).
    expect(diff(update, toWire(mapped)).map(({ change, path }) => `${change} ${path}`)).toEqual([
      'added object.discoverable',
      'added object.indexable',
      'added object.nsfl',
    ]);
  });
});

describe('the fields of migration 0002', () => {
  const page = {
    type: 'Page',
    id: 'https://lemmy.test/post/2',
    attributedTo: 'https://lemmy.test/u/a',
    to: ['https://lemmy.test/c/lab', PUBLIC],
    cc: [],
    name: 'A cat',
    mediaType: 'text/html',
    sensitive: false,
    nsfl: false,
    commentsEnabled: true,
    stickied: false,
    audience: 'https://lemmy.test/c/lab',
  };
  const roundTrip = (json: object) => diff(json, toWire(fromWire(json))).filter(({ path }) => path !== '@context');

  it("maps Lemmy's Image attachment with its media type and alt text, and back", () => {
    const image = {
      ...page,
      attachment: [{ type: 'Image', url: 'https://lemmy.test/pictrs/image/cat.webp', mediaType: 'image/webp', name: 'A cat asleep' }],
    };
    expect(postFromPage(image)).toMatchObject({
      url: 'https://lemmy.test/pictrs/image/cat.webp',
      urlContentType: 'image/webp',
      altText: 'A cat asleep',
    });
    expect(roundTrip(image)).toEqual([]);
  });

  it("maps PieFed's Image attachment without a media type as an image post, and back", () => {
    const image = { ...page, attachment: [{ type: 'Image', url: 'https://piefed.test/static/cat.png', name: 'A cat' }] };
    expect(postFromPage(image)).toMatchObject({ urlContentType: IMAGE_TYPE, altText: 'A cat' });
    expect(roundTrip(image)).toEqual([]);
  });

  it('sends an image post as an Image with mediaType and name, a link post as a Link', () => {
    const image = postToPage({ ...post, url: 'https://feddit.test/pictrs/a.png', urlContentType: 'image/png', altText: 'A chart' });
    expect(image.attachment).toEqual([{ type: 'Image', url: 'https://feddit.test/pictrs/a.png', mediaType: 'image/png', name: 'A chart' }]);
    const link = postToPage({ ...post, url: 'https://example.org/a', urlContentType: 'text/html; charset=utf-8', altText: null });
    expect(link.attachment).toEqual([{ href: 'https://example.org/a', type: 'Link', mediaType: 'text/html; charset=utf-8' }]);
  });

  it('maps the preview image and nsfl of a link post, and back', () => {
    const linked = {
      ...page,
      nsfl: true,
      attachment: [{ type: 'Link', href: 'https://example.org/story' }],
      image: { type: 'Image', url: 'https://lemmy.test/pictrs/image/preview.jpg' },
    };
    expect(postFromPage(linked)).toMatchObject({
      url: 'https://example.org/story',
      urlContentType: null,
      altText: null,
      thumbnailUrl: 'https://lemmy.test/pictrs/image/preview.jpg',
      nsfl: true,
    });
    expect(roundTrip(linked)).toEqual([]);
  });

  it("maps a PieFed Group's languages, nsfl, posting warning and search consent, and back", () => {
    const id = 'https://piefed.test/c/cats';
    const group = {
      type: 'Group',
      id,
      preferredUsername: 'cats',
      inbox: `${id}/inbox`,
      attributedTo: `${id}/moderators`,
      sensitive: false,
      nsfl: true,
      postingRestrictedToMods: false,
      postingWarning: 'Cats only',
      discoverable: false,
      indexable: false,
      language: [
        { identifier: 'und', name: 'Undetermined' },
        { identifier: 'en', name: 'English' },
      ],
    };
    expect(actorFromWire(group)).toMatchObject({
      nsfl: true,
      postingWarning: 'Cats only',
      discoverable: false,
      indexable: false,
      languages: ['und', 'en'],
    });
    expect(roundTrip(group)).toEqual([]);
  });

  it('reads absent search consent as the columns default and sends it on every actor', () => {
    const person = { type: 'Person', id: 'https://lemmy.test/u/a', preferredUsername: 'a', inbox: 'https://lemmy.test/u/a/inbox' };
    expect(actorFromWire(person)).toMatchObject({ discoverable: true, indexable: true, nsfl: false, languages: [] });
    expect(roundTrip({ ...person, discoverable: false, indexable: true })).toEqual([]);
  });
});

describe('caller preconditions', () => {
  it("keeps the key's owner as sent: the inbound handler, not the mapping, checks it", () => {
    const id = 'https://lemmy.test/u/a';
    const pem = '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n';
    const person = {
      type: 'Person',
      id,
      preferredUsername: 'a',
      inbox: `${id}/inbox`,
      publicKey: { id: 'https://other.test/u/b#main-key', owner: 'https://other.test/u/b', publicKeyPem: pem },
    };
    expect(actorFromWire(person).publicKey).toEqual({ keyId: 'https://other.test/u/b#main-key', ownerApId: 'https://other.test/u/b', pem });
    expect(diff(person, toWire(fromWire(person))).filter(({ path }) => path.startsWith('publicKey'))).toEqual([]);
  });
});

describe('URL schemes', () => {
  afterEach(() => vi.unstubAllEnvs());
  const person = { type: 'Person', id: 'https://x.test/u/a', preferredUsername: 'a', inbox: 'https://x.test/u/a/inbox' };
  const page = { type: 'Page', id: 'https://x.test/post/1', attributedTo: person.id, name: 'x', audience: 'https://x.test/c/lab' };
  const unsafe = ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd'];

  it('accepts only https ids, inboxes, collections and addresses', () => {
    for (const value of [...unsafe, 'http://x.test/u/a']) {
      expect(() => actorFromWire({ ...person, id: value })).toThrow(/actor: id must be an https URL/);
      expect(() => actorFromWire({ ...person, inbox: value })).toThrow(/actor: inbox must be an https URL/);
      expect(() => actorFromWire({ ...person, followers: value })).toThrow(/actor: followers must be an https URL/);
      expect(() => postFromPage({ ...page, cc: [value] })).toThrow(/Page: cc.* must be an https URL/);
      expect(() => fromWire({ type: 'Like', id: 'https://x.test/like/1', actor: value, object: page.id })).toThrow(MappingError);
    }
    const { audience, ...addressedByTo } = page;
    expect(postFromPage({ ...addressedByTo, to: ['as:Public', audience] }).communityApId).toBe(audience);
  });

  it('accepts http only in local development, for a localhost or .test host', () => {
    vi.stubEnv('PEBLISH_ALLOW_HTTP_ORIGIN', '1');
    expect(actorFromWire({ ...person, id: 'http://x.test/u/a' }).apId).toBe('http://x.test/u/a');
    expect(() => actorFromWire({ ...person, id: 'http://example.org/u/a' })).toThrow(/must be an https URL/);
    expect(() => actorFromWire({ ...person, id: 'javascript:alert(1)' })).toThrow(/must be an https URL/);
  });

  it('accepts http(s) icons and banners only', () => {
    expect(actorFromWire({ ...person, icon: { type: 'Image', url: 'http://img.example/a.png' } }).iconUrl).toBe('http://img.example/a.png');
    for (const value of unsafe) {
      expect(() => actorFromWire({ ...person, icon: { type: 'Image', url: value } })).toThrow(/actor: icon.url must be an http\(s\) URL/);
      expect(() => actorFromWire({ ...person, image: { type: 'Image', url: value } })).toThrow(/actor: image.url must be an http\(s\) URL/);
    }
  });

  it('maps a post link that is not http(s) to no link instead of refusing the post', () => {
    const link = (href: string) => postFromPage({ ...page, attachment: [{ type: 'Link', href }] }).url;
    expect(link('http://example.org/a')).toBe('http://example.org/a');
    expect(link('https://example.org/a')).toBe('https://example.org/a');
    for (const value of [...unsafe, 'not a url']) expect(link(value)).toBeNull();
  });
});
