import { constants, openSync, readFileSync, writeSync, closeSync, fstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { type } from 'arktype';

// The cutover bundle: what `export` reads from the PieFed archive and `import` writes into
// peblish. It holds private keys and email addresses, so it is only ever written with mode 600,
// outside the repository, and never printed (deploy/cutover.md). No password hashes: the
// imported accounts sign in through a password reset (LANE-NOTES, the password decision).

const Key = type({ keyId: 'string', publicKeyPem: 'string', privateKeyPem: 'string' });

const LocalActor = type({
  apId: 'string',
  name: 'string',
  displayName: 'string | null',
  summaryMd: 'string | null',
  inboxUrl: 'string',
  sharedInboxUrl: 'string',
  outboxUrl: 'string',
  followersUrl: 'string | null',
  /** ISO timestamp. */
  publishedAt: 'string | null',
  key: Key,
});

export const BundleUser = LocalActor.and({
  email: 'string',
  emailVerified: 'boolean',
  role: "'user' | 'admin'",
  discoverable: 'boolean',
  indexable: 'boolean',
  bot: 'boolean',
});

export const BundleCommunity = LocalActor.and({
  featuredUrl: 'string',
  moderatorsUrl: 'string',
  sensitive: 'boolean',
  nsfl: 'boolean',
  postingRestrictedToMods: 'boolean',
  postingWarning: 'string | null',
  discoverable: 'boolean',
  indexable: 'boolean',
  languages: 'string[]',
  /** ap_ids of bundle users: the owner first, then moderators. */
  owners: 'string[]',
  moderators: 'string[]',
  /** PieFed's local_only: it never federated (peblish has no such switch; recorded only). */
  localOnly: 'boolean',
});

export const BundleRemoteCommunity = type({
  apId: 'string',
  name: 'string',
  displayName: 'string | null',
  summaryHtml: 'string | null',
  inboxUrl: 'string | null',
  sharedInboxUrl: 'string | null',
  outboxUrl: 'string | null',
  followersUrl: 'string | null',
  featuredUrl: 'string | null',
  moderatorsUrl: 'string | null',
  iconUrl: 'string | null',
  bannerUrl: 'string | null',
  sensitive: 'boolean',
  nsfl: 'boolean',
  postingRestrictedToMods: 'boolean',
  languages: 'string[]',
  publishedAt: 'string | null',
  publicKey: type({ keyId: 'string', pem: 'string' }).or('null'),
  /** What PieFed knew of the peer, for the inventory and verify reports. */
  software: 'string | null',
  dormant: 'boolean',
});

export const BundleFollow = type({
  followerApId: 'string',
  followeeApId: 'string',
  /** The Follow activity id PieFed sent (null for a follow of a local community). */
  apId: 'string | null',
  acceptedAt: 'string',
});

export const Bundle = type({
  format: "'peblish.cutover/1'",
  exportedAt: 'string',
  source: { software: 'string', version: 'string', schema: 'string', origin: 'string' },
  instanceActor: {
    apId: 'string',
    name: 'string',
    displayName: 'string | null',
    inboxUrl: 'string',
    sharedInboxUrl: 'string',
    outboxUrl: 'string',
    key: Key,
  },
  users: BundleUser.array(),
  communities: BundleCommunity.array(),
  remoteCommunities: BundleRemoteCommunity.array(),
  follows: BundleFollow.array(),
  /** PieFed's banned instances (banned_instances.domain), lowercase hosts: the import blocks each as a peer. */
  blockedInstances: 'string[]',
});
export type Bundle = typeof Bundle.infer;

const repositoryRoot = resolve(import.meta.dirname, '../../..');

/** Refuses a path inside this repository: a bundle, backup or ledger export is never committed. */
export function assertOutsideRepository(path: string): string {
  const absolute = resolve(path);
  if (absolute === repositoryRoot || absolute.startsWith(repositoryRoot + sep)) {
    throw new Error(`refusing to write ${absolute}: it is inside the repository; use a scratch folder`);
  }
  return absolute;
}

/** Opens `path` for writing with mode 600, refusing an existing file unless `replace`. Returns the descriptor. */
export function openPrivate(path: string, replace = false): number {
  const absolute = assertOutsideRepository(path);
  const flags = constants.O_WRONLY | constants.O_CREAT | (replace ? constants.O_TRUNC : constants.O_EXCL);
  const fd = openSync(absolute, flags, 0o600);
  // An existing file kept its mode under O_TRUNC; refuse rather than write secrets into it.
  if ((fstatSync(fd).mode & 0o077) !== 0) {
    closeSync(fd);
    throw new Error(`refusing to write ${absolute}: it is readable by others (chmod 600 it or remove it)`);
  }
  return fd;
}

/** Writes `text` to `path` with mode 600 (see openPrivate). */
export function writePrivate(path: string, text: string, replace = false): void {
  const fd = openPrivate(path, replace);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

export function readBundle(path: string): Bundle {
  return Bundle.assert(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeBundle(path: string, bundle: Bundle, replace = false): void {
  writePrivate(path, `${JSON.stringify(Bundle.assert(bundle), null, 2)}\n`, replace);
}

/**
 * The bundle's local URLs moved from its origin to `origin` (a throwaway rehearsal host); remote
 * ones are kept. The people's email addresses become `<name>@<rehearsal host>`: a rehearsal proves
 * the ids and keys, and needs no one's real address in a throwaway database.
 */
export function rehostBundle(bundle: Bundle, origin: string): Bundle {
  const from = new URL(bundle.source.origin).origin;
  const to = new URL(origin).origin;
  const move = (url: string): string => (url === from || url.startsWith(`${from}/`) ? to + url.slice(from.length) : url);
  const moveOrNull = (url: string | null) => (url === null ? null : move(url));
  const actor = <T extends { apId: string; inboxUrl: string; sharedInboxUrl: string; outboxUrl: string; key: { keyId: string } }>(
    value: T,
  ): T => ({
    ...value,
    apId: move(value.apId),
    inboxUrl: move(value.inboxUrl),
    sharedInboxUrl: move(value.sharedInboxUrl),
    outboxUrl: move(value.outboxUrl),
    key: { ...value.key, keyId: move(value.key.keyId) },
  });
  return {
    ...bundle,
    source: { ...bundle.source, origin: to },
    instanceActor: { ...actor(bundle.instanceActor), name: new URL(to).host },
    users: bundle.users.map((user) => ({
      ...actor(user),
      followersUrl: moveOrNull(user.followersUrl),
      email: `${user.name.toLowerCase()}@${new URL(to).host}`,
    })),
    communities: bundle.communities.map((community) => ({
      ...actor(community),
      followersUrl: moveOrNull(community.followersUrl),
      featuredUrl: move(community.featuredUrl),
      moderatorsUrl: move(community.moderatorsUrl),
      owners: community.owners.map(move),
      moderators: community.moderators.map(move),
    })),
    follows: bundle.follows.map((follow) => ({
      ...follow,
      followerApId: move(follow.followerApId),
      followeeApId: move(follow.followeeApId),
      apId: moveOrNull(follow.apId),
    })),
  };
}
