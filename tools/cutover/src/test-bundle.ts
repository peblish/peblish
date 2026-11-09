import { newRsaKeyPair } from '@peblish/core/actor-keys';
import { Bundle } from './bundle.ts';

// A small cutover bundle with generated keys, shaped like feddit.com's (tests never read the
// archive): feddit-admin and Andrew, announcements (owned by feddit-admin, local only) and
// microblogs, one remote Lemmy community feddit-admin follows, and its follow of announcements.

export const testOrigin = 'https://feddit.test';
export const remoteCommunity = 'https://lemmy.test/c/news';

export async function testBundle(): Promise<Bundle> {
  const [instance, admin, andrew, announcements, microblogs, remote] = await Promise.all([
    newRsaKeyPair(),
    newRsaKeyPair(),
    newRsaKeyPair(),
    newRsaKeyPair(),
    newRsaKeyPair(),
    newRsaKeyPair(),
  ]);
  const key = (apId: string, pair: { publicKeyPem: string; privateKeyPem: string }) => ({ keyId: `${apId}#main-key`, ...pair });
  const user = (name: string, pair: typeof admin, role: 'user' | 'admin') => {
    const apId = `${testOrigin}/u/${name}`;
    return {
      apId,
      name,
      displayName: null,
      summaryMd: null,
      inboxUrl: `${apId}/inbox`,
      sharedInboxUrl: `${testOrigin}/inbox`,
      outboxUrl: `${apId}/outbox`,
      followersUrl: `${apId}/followers`,
      publishedAt: '2025-06-21T00:00:00.000Z',
      key: key(apId, pair),
      email: `${name.toLowerCase()}@mail.test`,
      emailVerified: true,
      role,
      discoverable: true,
      indexable: false,
      bot: false,
    };
  };
  const community = (name: string, pair: typeof admin, localOnly: boolean) => {
    const apId = `${testOrigin}/c/${name}`;
    return {
      apId,
      name,
      displayName: name,
      summaryMd: localOnly ? null : 'Short posts from **anywhere**.',
      inboxUrl: `${apId}/inbox`,
      sharedInboxUrl: `${testOrigin}/inbox`,
      outboxUrl: `${apId}/outbox`,
      followersUrl: `${apId}/followers`,
      featuredUrl: `${apId}/featured`,
      moderatorsUrl: `${apId}/moderators`,
      publishedAt: '2025-06-23T00:00:00.000Z',
      key: key(apId, pair),
      sensitive: false,
      nsfl: false,
      postingRestrictedToMods: localOnly,
      postingWarning: null,
      discoverable: true,
      indexable: true,
      languages: ['en'],
      owners: [`${testOrigin}/u/feddit-admin`],
      moderators: [],
      localOnly,
    };
  };
  return Bundle.assert({
    format: 'peblish.cutover/1',
    exportedAt: '2026-11-10T00:00:00.000Z',
    source: { software: 'piefed', version: '1.8', schema: 'test', origin: testOrigin },
    instanceActor: {
      apId: `${testOrigin}/actor`,
      name: 'feddit.test',
      displayName: 'Feddit (Beta)',
      inboxUrl: `${testOrigin}/actor/inbox`,
      sharedInboxUrl: `${testOrigin}/inbox`,
      outboxUrl: `${testOrigin}/actor/outbox`,
      key: key(`${testOrigin}/actor`, instance),
    },
    users: [user('feddit-admin', admin, 'user'), user('Andrew', andrew, 'admin')],
    communities: [community('announcements', announcements, true), community('microblogs', microblogs, false)],
    remoteCommunities: [
      {
        apId: remoteCommunity,
        name: 'news',
        displayName: 'News',
        summaryHtml: '<p>News</p>',
        inboxUrl: 'https://lemmy.test/inbox',
        sharedInboxUrl: 'https://lemmy.test/inbox',
        outboxUrl: `${remoteCommunity}/outbox`,
        followersUrl: `${remoteCommunity}/followers`,
        featuredUrl: `${remoteCommunity}/featured`,
        moderatorsUrl: `${remoteCommunity}/moderators`,
        iconUrl: null,
        bannerUrl: null,
        sensitive: false,
        nsfl: false,
        postingRestrictedToMods: false,
        languages: ['en'],
        publishedAt: '2023-06-01T00:00:00.000Z',
        publicKey: { keyId: `${remoteCommunity}#main-key`, pem: remote.publicKeyPem },
        software: 'lemmy',
        dormant: false,
      },
    ],
    follows: [
      {
        followerApId: `${testOrigin}/u/feddit-admin`,
        followeeApId: `${testOrigin}/c/announcements`,
        apId: null,
        acceptedAt: '2025-06-23T00:00:00.000Z',
      },
      {
        followerApId: `${testOrigin}/u/feddit-admin`,
        followeeApId: remoteCommunity,
        apId: `${testOrigin}/activities/follow/0b8a3c1e-1d2f-4a5b-9c6d-7e8f90a1b2c3`,
        acceptedAt: '2025-06-23T00:00:00.000Z',
      },
    ],
  });
}
