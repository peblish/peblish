import { describe, expect, test } from 'vitest';
import { exportBundle, inventory } from './archive.ts';

// The PieFed archive of feddit.com never leaves the maintainer's machine, so CI skips this.
// Locally: restore piefed-db.dump into its own database (deploy/cutover.md, step 3) and set
// CUTOVER_ARCHIVE_DB_URL. Nothing is written and no key or address is printed.
const url = process.env.CUTOVER_ARCHIVE_DB_URL;

describe.skipIf(!url)('the feddit.com archive', () => {
  test('inventory: one local member of announcements, none of microblogs, no chat, 131 follows of feddit-admin', async () => {
    const report = await inventory(url ?? '');
    expect(report.members).toEqual([
      { community: 'announcements', localOnly: true, local: ['feddit-admin'], remote: 0 },
      { community: 'microblogs', localOnly: false, local: [], remote: 0 },
    ]);
    expect([report.chatMessages, report.conversations, report.localPosts, report.localComments]).toEqual([0, 0, 0, 0]);
    expect(report.follows.find((row) => row.user === 'feddit-admin')).toMatchObject({
      total: 131,
      toRemote: 130,
      toLocal: 1,
      pendingOnly: 0,
    });
  });

  test('export: the instance actor, two users, two communities, 130 remote communities and 131 follows, no password hash', async () => {
    const bundle = await exportBundle(url ?? '', { admins: ['Andrew'] });
    expect(bundle.instanceActor.apId).toBe('https://feddit.com/actor');
    expect(bundle.users.map((user) => [user.apId, user.role])).toEqual([
      ['https://feddit.com/u/feddit-admin', 'user'],
      ['https://feddit.com/u/Andrew', 'admin'],
    ]);
    expect(bundle.communities.map((community) => community.apId)).toEqual([
      'https://feddit.com/c/announcements',
      'https://feddit.com/c/microblogs',
    ]);
    expect(bundle.remoteCommunities).toHaveLength(130);
    expect(bundle.follows.filter((follow) => follow.apId?.startsWith('https://feddit.com/activities/follow/'))).toHaveLength(130);
    // A boolean, so a failure cannot print the bundle (it holds keys and addresses).
    expect(/pbkdf2:|scrypt:/.test(JSON.stringify(bundle))).toBe(false);
  });
});
