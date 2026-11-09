import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { Bundle, type Bundle as BundleType } from './bundle.ts';

// Reading the PieFed 1.8 archive of feddit.com, restored into its own database (deploy/cutover.md,
// step 3). `inventory` reads counts and public facts only. `export` also reads the columns the
// import needs, private keys and email addresses among them, and returns them in the bundle for
// the caller to write with mode 600; nothing here logs a row. Password hashes are never read.

type Sql = postgres.Sql;

/** PieFed keeps naive UTC timestamps; read them as ISO strings in UTC. */
const iso = (column: string) => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The two local communities the cutover plan asks about. */
const askedCommunities = ['announcements', 'microblogs'];

export type Inventory = {
  origin: string;
  schema: string;
  localUsers: string[];
  localCommunities: string[];
  members: { community: string; localOnly: boolean; local: string[]; remote: number }[];
  chatMessages: number;
  conversations: number;
  localPosts: number;
  localComments: number;
  follows: {
    user: string;
    /** PieFed memberships (community_member): it writes one when the Accept arrives, or at once for a local community. */
    total: number;
    toLocal: number;
    toRemote: number;
    /** A Follow id is known (community_join_request). */
    withFollowId: number;
    /** A join request with no membership: the Accept never came. */
    pendingOnly: number;
    banned: number;
    onDormantInstances: number;
    instances: number;
    bySoftware: Record<string, number>;
  }[];
};

async function origin(sql: Sql): Promise<string> {
  // PieFed's own instance row is the first one it creates (id 1), named after SERVER_NAME.
  const [self] = await sql<{ domain: string }[]>`select domain from instance where id = 1`;
  if (!self) throw new Error('the archive has no instance row 1 (PieFed names itself there)');
  return `https://${self.domain}`;
}

async function schemaVersion(sql: Sql): Promise<string> {
  const [row] = await sql<{ version_num: string }[]>`select version_num from alembic_version`;
  return row?.version_num ?? 'unknown';
}

const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;

export async function inventory(url: string): Promise<Inventory> {
  const sql = postgres(url, { max: 2, onnotice: () => undefined });
  try {
    const localUsers = (
      await sql<{ user_name: string }[]>`select user_name from "user" where ap_id is null and not deleted order by id`
    ).map((row) => row.user_name);
    const localCommunities = (await sql<{ name: string }[]>`select name from community where ap_id is null order by id`).map(
      (row) => row.name,
    );
    const members = [];
    for (const name of askedCommunities) {
      const [community] = await sql<
        { id: number; local_only: boolean }[]
      >`select id, local_only from community where ap_id is null and name = ${name}`;
      if (!community) continue;
      const rows = await sql<{ user_name: string; remote: boolean }[]>`
        select u.user_name, u.ap_id is not null as remote from community_member m join "user" u on u.id = m.user_id
        where m.community_id = ${community.id} order by u.id`;
      members.push({
        community: name,
        localOnly: community.local_only,
        local: rows.filter((row) => !row.remote).map((row) => row.user_name),
        remote: rows.filter((row) => row.remote).length,
      });
    }
    const follows = [];
    for (const user of localUsers) {
      const [row] = await sql<
        { total: number; to_local: number; to_remote: number; with_follow_id: number; banned: number; dormant: number; instances: number }[]
      >`
        select count(*)::int as total,
          count(*) filter (where c.ap_id is null)::int as to_local,
          count(*) filter (where c.ap_id is not null)::int as to_remote,
          count(r.id) filter (where c.ap_id is not null)::int as with_follow_id,
          count(*) filter (where m.is_banned)::int as banned,
          count(*) filter (where c.ap_id is not null and (i.dormant or i.gone_forever))::int as dormant,
          count(distinct c.instance_id) filter (where c.ap_id is not null)::int as instances
        from community_member m join "user" u on u.id = m.user_id join community c on c.id = m.community_id
        join instance i on i.id = c.instance_id
        left join community_join_request r on r.user_id = m.user_id and r.community_id = m.community_id
        where u.ap_id is null and u.user_name = ${user}`;
      const pendingOnly = await count(sql<{ n: number }[]>`
        select count(*)::int as n from community_join_request r join "user" u on u.id = r.user_id
        left join community_member m on m.user_id = r.user_id and m.community_id = r.community_id
        where u.ap_id is null and u.user_name = ${user} and m.user_id is null`);
      const software = await sql<{ software: string | null; n: number }[]>`
        select i.software, count(*)::int as n from community_member m join "user" u on u.id = m.user_id
        join community c on c.id = m.community_id join instance i on i.id = c.instance_id
        where u.ap_id is null and u.user_name = ${user} and c.ap_id is not null group by 1 order by 2 desc, 1`;
      follows.push({
        user,
        total: row?.total ?? 0,
        toLocal: row?.to_local ?? 0,
        toRemote: row?.to_remote ?? 0,
        withFollowId: row?.with_follow_id ?? 0,
        pendingOnly,
        banned: row?.banned ?? 0,
        onDormantInstances: row?.dormant ?? 0,
        instances: row?.instances ?? 0,
        bySoftware: Object.fromEntries(software.map((entry) => [entry.software ?? 'unknown', entry.n])),
      });
    }
    return {
      origin: await origin(sql),
      schema: await schemaVersion(sql),
      localUsers,
      localCommunities,
      members,
      chatMessages: await count(sql<{ n: number }[]>`select count(*)::int as n from chat_message`),
      conversations: await count(sql<{ n: number }[]>`select count(*)::int as n from conversation`),
      localPosts: await count(
        sql<{ n: number }[]>`select count(*)::int as n from post p join "user" u on u.id = p.user_id where u.ap_id is null`,
      ),
      localComments: await count(
        sql<{ n: number }[]>`select count(*)::int as n from post_reply r join "user" u on u.id = r.user_id where u.ap_id is null`,
      ),
      follows,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const str = (value: string | null | undefined) => (value ? value : null);

/**
 * The bundle for the cutover, from the archive. `admins` names the local users who become site
 * admins (decision 7: Andrew alone); everyone else imports as a user, whatever PieFed's role.
 * Ids are PieFed's public_url() (ap_public_url, then SERVER_URL/u/<name>), which is what peers
 * stored: for `Andrew` that is /u/Andrew, not the lowercase ap_profile_id.
 */
export async function exportBundle(url: string, { admins }: { admins: readonly string[] }): Promise<BundleType> {
  const sql = postgres(url, { max: 2, onnotice: () => undefined });
  try {
    const base = await origin(sql);
    const host = new URL(base).host;
    const [site] = await sql<{ name: string; public_key: string | null; private_key: string | null }[]>`
      select name, public_key, private_key from site order by id limit 1`;
    if (!site?.public_key || !site.private_key) throw new Error('the archive site row has no instance actor key');

    const users = await sql<
      {
        id: number;
        user_name: string;
        title: string | null;
        about: string | null;
        email: string | null;
        verified: boolean;
        created: string | null;
        public_key: string | null;
        private_key: string | null;
        ap_public_url: string | null;
        searchable: boolean | null;
        indexable: boolean | null;
        bot: boolean;
      }[]
    >`
      select id, user_name, title, about, email, verified, ${sql.unsafe(iso('created'))} as created, public_key, private_key,
        ap_public_url, searchable, indexable, bot
      from "user" where ap_id is null and not deleted order by id`;
    const unknownAdmins = admins.filter((name) => !users.some((user) => user.user_name === name));
    if (unknownAdmins.length > 0) throw new Error(`--admin names no local user: ${unknownAdmins.join(', ')}`);
    const userApId = new Map<number, string>();
    const bundleUsers = users.map((user) => {
      if (!user.public_key || !user.private_key) throw new Error(`local user ${user.user_name} has no key pair`);
      if (!user.email) throw new Error(`local user ${user.user_name} has no email address`);
      const apId = user.ap_public_url ?? `${base}/u/${user.user_name}`;
      userApId.set(user.id, apId);
      return {
        apId,
        name: user.user_name,
        displayName: str(user.title),
        summaryMd: str(user.about),
        inboxUrl: `${apId}/inbox`,
        sharedInboxUrl: `${base}/inbox`,
        outboxUrl: `${apId}/outbox`,
        followersUrl: `${apId}/followers`,
        publishedAt: user.created,
        key: { keyId: `${apId}#main-key`, publicKeyPem: user.public_key, privateKeyPem: user.private_key },
        email: user.email.trim().toLowerCase(),
        emailVerified: user.verified,
        role: admins.includes(user.user_name) ? ('admin' as const) : ('user' as const),
        discoverable: user.searchable ?? true,
        indexable: user.indexable ?? true,
        bot: user.bot,
      };
    });

    const languagesOf = async (ids: number[]) => {
      if (ids.length === 0) return new Map<number, string[]>();
      const rows = await sql<{ community_id: number; code: string }[]>`
        select cl.community_id, l.code from community_language cl join language l on l.id = cl.language_id
        where cl.community_id in ${sql(ids)} order by l.id`;
      const map = new Map<number, string[]>();
      for (const row of rows) map.set(row.community_id, [...(map.get(row.community_id) ?? []), row.code.toLowerCase()]);
      return map;
    };

    const communities = await sql<
      {
        id: number;
        user_id: number | null;
        name: string;
        title: string | null;
        description: string | null;
        nsfw: boolean;
        nsfl: boolean;
        restricted_to_mods: boolean;
        posting_warning: string | null;
        searchable: boolean | null;
        local_only: boolean;
        created_at: string | null;
        public_key: string | null;
        private_key: string | null;
        ap_public_url: string | null;
      }[]
    >`
      select id, user_id, name, title, description, nsfw, nsfl, restricted_to_mods, posting_warning, searchable, local_only,
        ${sql.unsafe(iso('created_at'))} as created_at, public_key, private_key, ap_public_url
      from community where ap_id is null order by id`;
    const localLanguages = await languagesOf(communities.map((community) => community.id));
    const staff = await sql<{ community_id: number; user_id: number; is_owner: boolean; is_moderator: boolean }[]>`
      select m.community_id, m.user_id, m.is_owner, m.is_moderator from community_member m join community c on c.id = m.community_id
      where c.ap_id is null and (m.is_owner or m.is_moderator) and not m.is_banned order by m.created_at`;
    const bundleCommunities = communities.map((community) => {
      if (!community.public_key || !community.private_key) throw new Error(`local community ${community.name} has no key pair`);
      const apId = community.ap_public_url ?? `${base}/c/${community.name}`;
      const rows = staff.filter((row) => row.community_id === community.id);
      // The owner is the member PieFed marks owner, else the creator.
      const ownerIds = rows.filter((row) => row.is_owner).map((row) => row.user_id);
      if (ownerIds.length === 0 && community.user_id !== null) ownerIds.push(community.user_id);
      const moderatorIds = rows.filter((row) => !ownerIds.includes(row.user_id)).map((row) => row.user_id);
      const toApIds = (ids: number[]) => [...new Set(ids)].flatMap((id) => userApId.get(id) ?? []);
      return {
        apId,
        name: community.name,
        displayName: str(community.title),
        summaryMd: str(community.description),
        inboxUrl: `${apId}/inbox`,
        sharedInboxUrl: `${base}/inbox`,
        outboxUrl: `${apId}/outbox`,
        followersUrl: `${apId}/followers`,
        featuredUrl: `${apId}/featured`,
        moderatorsUrl: `${apId}/moderators`,
        publishedAt: community.created_at,
        key: { keyId: `${apId}#main-key`, publicKeyPem: community.public_key, privateKeyPem: community.private_key },
        // Not safe for life is stricter than NSFW, so the age gate covers it (as community.create does).
        sensitive: community.nsfw || community.nsfl,
        nsfl: community.nsfl,
        postingRestrictedToMods: community.restricted_to_mods,
        postingWarning: str(community.posting_warning),
        discoverable: community.searchable ?? true,
        indexable: community.searchable ?? true,
        languages: localLanguages.get(community.id) ?? [],
        owners: toApIds(ownerIds),
        moderators: toApIds(moderatorIds),
        localOnly: community.local_only,
      };
    });
    const communityApId = new Map(communities.map((community, index) => [community.id, bundleCommunities[index]!.apId]));

    // Every remote community a local user follows, as PieFed cached it.
    const remote = await sql<
      {
        id: number;
        name: string;
        ap_preferred_username: string | null;
        title: string | null;
        description_html: string | null;
        ap_profile_id: string;
        ap_inbox_url: string | null;
        ap_outbox_url: string | null;
        ap_followers_url: string | null;
        ap_featured_url: string | null;
        ap_moderators_url: string | null;
        icon_url: string | null;
        banner_url: string | null;
        nsfw: boolean;
        nsfl: boolean;
        restricted_to_mods: boolean;
        created_at: string | null;
        public_key: string | null;
        instance_inbox: string | null;
        software: string | null;
        dormant: boolean;
      }[]
    >`
      select c.id, c.name, c.ap_preferred_username, c.title, c.description_html, c.ap_profile_id, c.ap_inbox_url, c.ap_outbox_url,
        c.ap_followers_url, c.ap_featured_url, c.ap_moderators_url, icon.source_url as icon_url, banner.source_url as banner_url,
        c.nsfw, c.nsfl, c.restricted_to_mods, ${sql.unsafe(iso('c.created_at'))} as created_at, c.public_key,
        i.inbox as instance_inbox, i.software, (i.dormant or i.gone_forever) as dormant
      from community c join instance i on i.id = c.instance_id
      left join file icon on icon.id = c.icon_id left join file banner on banner.id = c.image_id
      where c.ap_id is not null and c.id in (
        select m.community_id from community_member m join "user" u on u.id = m.user_id where u.ap_id is null and not m.is_banned)
      order by c.id`;
    const remoteLanguages = await languagesOf(remote.map((community) => community.id));
    const sameOrigin = (url: string | null, of: string) => (url && new URL(url).origin === new URL(of).origin ? url : null);
    const bundleRemote = remote.map((community) => ({
      apId: community.ap_profile_id,
      name: community.ap_preferred_username ?? community.name,
      displayName: str(community.title),
      summaryHtml: str(community.description_html),
      inboxUrl: sameOrigin(community.ap_inbox_url, community.ap_profile_id),
      sharedInboxUrl: sameOrigin(community.instance_inbox, community.ap_profile_id),
      outboxUrl: sameOrigin(community.ap_outbox_url, community.ap_profile_id),
      followersUrl: sameOrigin(community.ap_followers_url, community.ap_profile_id),
      featuredUrl: sameOrigin(community.ap_featured_url, community.ap_profile_id),
      moderatorsUrl: sameOrigin(community.ap_moderators_url, community.ap_profile_id),
      iconUrl: str(community.icon_url),
      bannerUrl: str(community.banner_url),
      sensitive: community.nsfw || community.nsfl,
      nsfl: community.nsfl,
      postingRestrictedToMods: community.restricted_to_mods,
      languages: remoteLanguages.get(community.id) ?? [],
      publishedAt: community.created_at,
      publicKey: community.public_key ? { keyId: `${community.ap_profile_id}#main-key`, pem: community.public_key } : null,
      software: str(community.software),
      dormant: community.dormant,
    }));
    for (const community of remote) communityApId.set(community.id, community.ap_profile_id);

    // Memberships, with the Follow id PieFed sent (activities/follow/<join request uuid>).
    const memberships = await sql<{ user_id: number; community_id: number; created_at: string; uuid: string | null; remote: boolean }[]>`
      select m.user_id, m.community_id, ${sql.unsafe(iso('m.created_at'))} as created_at, r.uuid::text as uuid, c.ap_id is not null as remote
      from community_member m join "user" u on u.id = m.user_id join community c on c.id = m.community_id
      left join community_join_request r on r.user_id = m.user_id and r.community_id = m.community_id
      where u.ap_id is null and not u.deleted and not m.is_banned order by m.created_at, m.community_id`;
    const follows = memberships.map((row) => ({
      followerApId: userApId.get(row.user_id)!,
      followeeApId: communityApId.get(row.community_id)!,
      apId: row.remote && row.uuid ? `${base}/activities/follow/${row.uuid}` : null,
      acceptedAt: row.created_at,
    }));

    const [alembic] = await sql<{ version_num: string }[]>`select version_num from alembic_version`;
    return Bundle.assert({
      format: 'peblish.cutover/1',
      exportedAt: new Date().toISOString(),
      source: { software: 'piefed', version: '1.8', schema: alembic?.version_num ?? 'unknown', origin: base },
      // PieFed's instance actor (app/main/routes.py instance_actor): /actor, its own inbox, the shared /inbox.
      instanceActor: {
        apId: `${base}/actor`,
        name: host,
        displayName: str(site.name),
        inboxUrl: `${base}/actor/inbox`,
        sharedInboxUrl: `${base}/inbox`,
        outboxUrl: `${base}/actor/outbox`,
        key: { keyId: `${base}/actor#main-key`, publicKeyPem: site.public_key, privateKeyPem: site.private_key },
      },
      users: bundleUsers,
      communities: bundleCommunities,
      remoteCommunities: bundleRemote,
      follows,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A key's public half as SPKI DER, hashed: compares keys whatever the PEM wrapping (PKCS#1 or SPKI). */
export function publicFingerprint(pem: string): string {
  const key = pem.includes('PRIVATE KEY') ? createPublicKey(createPrivateKey(pem)) : createPublicKey(pem);
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

/**
 * Checks the bundle's keys against the key files exported with the archive (community-keys.json,
 * user-keys.json, site.json), by fingerprint: each public key must match its file's public key,
 * and each private key must be the private half of it. Returns the problems, without key material.
 */
export function crossCheckKeyFiles(bundle: BundleType, archiveDir: string): { checked: number; problems: string[] } {
  type Row = { public_key: string; private_key: string; ap_profile_id?: string; ap_public_url?: string; name?: string; user_name?: string };
  const read = (file: string) => JSON.parse(readFileSync(join(archiveDir, file), 'utf8')) as Row[];
  const problems: string[] = [];
  let checked = 0;
  const check = (label: string, key: { publicKeyPem: string; privateKeyPem: string }, file: Row | undefined) => {
    if (!file) {
      problems.push(`${label}: not in the key files`);
      return;
    }
    checked += 1;
    const fingerprint = publicFingerprint(key.publicKeyPem);
    if (fingerprint !== publicFingerprint(file.public_key)) problems.push(`${label}: public key differs from the key file`);
    if (fingerprint !== publicFingerprint(key.privateKeyPem)) problems.push(`${label}: private key is not the public key's pair`);
    if (publicFingerprint(file.private_key) !== publicFingerprint(key.privateKeyPem))
      problems.push(`${label}: private key differs from the key file`);
  };
  const users = read('user-keys.json');
  for (const user of bundle.users)
    check(
      `user ${user.name}`,
      user.key,
      users.find((row) => row.user_name === user.name),
    );
  const communities = read('community-keys.json');
  for (const community of bundle.communities) {
    check(
      `community ${community.name}`,
      community.key,
      communities.find((row) => row.name === community.name),
    );
  }
  check('instance actor', bundle.instanceActor.key, read('site.json')[0]);
  return { checked, problems };
}
