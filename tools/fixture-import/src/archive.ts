import { MappingError } from '@peblish/federation/mapping/json';
import { PUBLIC } from '@peblish/federation/mapping/vocabulary';
import { explain, roundTrip } from '@peblish/federation/test/corpus';
import { vocabularyByKey } from '@peblish/federation/test/vocabulary';
import postgres from 'postgres';

// The archive run: reads a subset of the PieFed archive of feddit.com (restored into its
// own database), renders each row as the document PieFed 1.8 federates for it, and runs the
// corpus round trip. PieFed keeps no received JSON (its activity log is empty in the
// archive), so PieFed's own rendering is the wire form; the PieFed-only settings of remote
// communities are PieFed's defaults, not the peer's, and are rendered for local ones only.
// The subset: the two local users, the two local communities, every remote community a
// local user follows, and the newest posts and comments of each origin software. Queries
// name their columns: no private key, email, password or IP address is ever read, and the
// run writes nothing (the report goes to stdout).

const SAMPLE = 20;
const ORIGIN = 'https://feddit.com';
const context = ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'];
/** PieFed's naive UTC timestamps, as PieFed's isoformat() sends them. */
const at = (column: string) => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')`;

type Row = Record<string, unknown>;
type Doc = { kind: 'actor' | 'community' | 'post' | 'comment'; software: string; id: string; json: Record<string, unknown> };

export type ArchiveReport = {
  documents: number;
  bySoftware: Map<string, number>;
  /** vocabulary key, change and document kind to the number of documents and the software seen. */
  deltas: Map<string, { vocabulary: string; change: string; kind: string; documents: number; software: Set<string> }>;
  unmappable: string[];
  undocumented: string[];
  notSampled: string[];
};

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
const defined = (fields: Row) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
const image = (url: unknown) => (str(url) ? { type: 'Image', url } : undefined);
const languageOf = (code: unknown, name: unknown) => (str(code) ? { identifier: code, name } : undefined);
const markdown = (body: unknown) => (str(body) ? { content: body, mediaType: 'text/markdown' } : undefined);

function person(row: Row): Doc {
  const id = String(row.ap_profile_id);
  return {
    kind: 'actor',
    software: 'piefed',
    id,
    json: defined({
      '@context': context,
      type: row.bot ? 'Service' : 'Person',
      id,
      preferredUsername: row.user_name,
      name: str(row.title) ?? row.user_name,
      summary: str(row.about_html),
      source: markdown(row.about),
      inbox: str(row.ap_inbox_url) ?? `${id}/inbox`,
      outbox: `${id}/outbox`,
      endpoints: { sharedInbox: `${ORIGIN}/inbox` },
      publicKey: str(row.public_key) ? { id: `${id}#main-key`, owner: id, publicKeyPem: row.public_key } : undefined,
      icon: image(row.avatar_url),
      image: image(row.cover_url),
      published: row.created,
      discoverable: row.searchable,
      indexable: row.indexable,
      manuallyApprovesFollowers: row.ap_manually_approves_followers,
      acceptPrivateMessages: row.accept_private_messages,
      attributionDomains: [new URL(ORIGIN).host],
      matrixUserId: str(row.matrix_user_id),
    }),
  };
}

function community(row: Row, languages: Row[], local: boolean): Doc {
  const id = String(row.ap_profile_id);
  const moderators = str(row.ap_moderators_url) ?? `${id}/moderators`;
  const settings = local
    ? {
        url: row.ap_public_url,
        moderators,
        nsfl: row.nsfl,
        genAI: row.ai_generated,
        postingWarning: str(row.posting_warning),
        newModsWanted: row.new_mods_wanted,
        privateMods: row.private_mods,
        questionAnswer: row.question_answer,
        contentRetention: row.content_retention,
        defaultPostType: str(row.default_post_type),
        postUrlType: str(row.post_url_type),
      }
    : {};
  return {
    kind: 'community',
    software: String(row.software),
    id,
    json: defined({
      '@context': context,
      type: 'Group',
      id,
      preferredUsername: row.name,
      name: row.title,
      summary: str(row.description_html),
      source: markdown(row.description),
      inbox: str(row.ap_inbox_url) ?? `${id}/inbox`,
      outbox: str(row.ap_outbox_url) ?? `${id}/outbox`,
      followers: str(row.ap_followers_url) ?? `${id}/followers`,
      featured: str(row.ap_featured_url) ?? `${id}/featured`,
      attributedTo: moderators,
      endpoints: str(row.shared_inbox) ? { sharedInbox: row.shared_inbox } : local ? { sharedInbox: `${ORIGIN}/inbox` } : undefined,
      publicKey: str(row.public_key) ? { id: `${id}#main-key`, owner: id, publicKeyPem: row.public_key } : undefined,
      icon: image(row.icon_url),
      image: image(row.banner_url),
      sensitive: row.nsfw,
      postingRestrictedToMods: row.restricted_to_mods,
      language: languages
        .filter((language) => language.community_id === row.id)
        .map((language) => languageOf(language.code, language.name)),
      published: row.created_at,
      ...settings,
    }),
  };
}

const IMAGE_POST = 3;

function page(row: Row): Doc {
  const id = String(row.ap_id);
  const url = str(row.url);
  const attachment = !url
    ? []
    : row.type === IMAGE_POST
      ? [defined({ type: 'Image', url, name: str(row.alt_text) })]
      : [{ href: url, type: 'Link' }];
  return {
    kind: 'post',
    software: String(row.software),
    id,
    json: defined({
      '@context': context,
      id,
      type: 'Page',
      attributedTo: row.author,
      to: [row.community, PUBLIC],
      cc: [],
      tag: [],
      audience: row.community,
      content: str(row.body_html),
      mediaType: 'text/html',
      source: markdown(row.body),
      published: row.published,
      updated: row.edited_at,
      language: languageOf(row.language_code, row.language_name),
      name: row.title,
      attachment,
      image: row.type === IMAGE_POST ? undefined : image(row.thumbnail_url),
      commentsEnabled: row.comments_enabled,
      sensitive: row.nsfw,
      nsfl: row.nsfl,
      genAI: row.ai_generated,
      stickied: row.sticky,
    }),
  };
}

function note(row: Row): Doc {
  const id = String(row.ap_id);
  const language = languageOf(row.language_code, row.language_name);
  return {
    kind: 'comment',
    software: String(row.software),
    id,
    json: defined({
      '@context': context,
      id,
      url: id,
      type: 'Note',
      attributedTo: row.author,
      to: [PUBLIC],
      cc: [row.community],
      tag: [],
      audience: row.community,
      content: str(row.body_html),
      mediaType: 'text/html',
      source: markdown(row.body),
      inReplyTo: row.in_reply_to,
      published: row.published,
      updated: row.edited_at,
      language,
      contentMap: language && str(row.body_html) ? { [String(row.language_code)]: row.body_html } : undefined,
      distinguished: row.distinguished,
    }),
  };
}

async function readDocuments(sql: postgres.Sql): Promise<{ docs: Doc[]; notSampled: string[] }> {
  const localUsers = await sql.unsafe(`
    select u.id, u.user_name, u.title, u.about, u.about_html, ${at('u.created')} as created, u.ap_profile_id, u.ap_inbox_url,
      u.bot, u.searchable, u.indexable, u.ap_manually_approves_followers, u.accept_private_messages, u.matrix_user_id, u.public_key,
      coalesce(a.source_url, a.file_path) as avatar_url, coalesce(c.source_url, c.file_path) as cover_url
    from "user" u left join file a on a.id = u.avatar_id left join file c on c.id = u.cover_id
    where u.ap_id is null and u.user_name in ('feddit-admin', 'Andrew') order by u.id`);
  const communityColumns = `c.id, c.name, c.title, c.description, c.description_html, ${at('c.created_at')} as created_at, c.ap_profile_id,
      c.ap_public_url, c.ap_inbox_url, c.ap_outbox_url, c.ap_followers_url, c.ap_featured_url, c.ap_moderators_url, c.public_key,
      c.nsfw, c.nsfl, c.restricted_to_mods, c.ai_generated, c.posting_warning, c.new_mods_wanted, c.private_mods, c.question_answer,
      c.content_retention, c.default_post_type, c.post_url_type, lower(i.software) as software, i.shared_inbox,
      coalesce(icon.source_url, icon.file_path) as icon_url, coalesce(banner.source_url, banner.file_path) as banner_url
    from community c join instance i on i.id = c.instance_id
      left join file icon on icon.id = c.icon_id left join file banner on banner.id = c.image_id`;
  const localCommunities = await sql.unsafe(
    `select ${communityColumns} where c.ap_id is null and c.name in ('announcements', 'microblogs') order by c.id`,
  );
  const followed = await sql.unsafe(`select ${communityColumns}
    where c.ap_id is not null and c.id in (select m.community_id from community_member m join "user" u on u.id = m.user_id where u.ap_id is null)
    order by c.id`);
  const languages = await sql.unsafe(
    `select cl.community_id, l.code, l.name from community_language cl join language l on l.id = cl.language_id order by l.id`,
  );
  const softwares = (
    await sql.unsafe(`select distinct i.software from post p join instance i on i.id = p.instance_id where p.ap_id is not null order by 1`)
  ).map((row) => String(row.software));
  // Rare software makes Postgres scan most of post_reply, so the samples run side by side.
  const samples = await Promise.all(
    softwares.map(async (software) => [
      // Polls (type 5) are Question objects, which the mapping does not read yet.
      await sql.unsafe(
        `select p.ap_id, p.type, p.title, p.url, p.body, p.body_html, p.nsfw, p.nsfl, p.sticky, p.comments_enabled, p.ai_generated,
          ${at('coalesce(p.posted_at, p.created_at)')} as published, ${at('p.edited_at')} as edited_at, l.code as language_code, l.name as language_name,
          u.ap_profile_id as author, c.ap_profile_id as community, i.software, f.source_url as thumbnail_url, f.alt_text
        from post p join instance i on i.id = p.instance_id join "user" u on u.id = p.user_id join community c on c.id = p.community_id
          left join language l on l.id = p.language_id left join file f on f.id = p.image_id
        where p.ap_id is not null and not p.deleted and p.type <> 5 and i.software = $1 order by p.id desc limit ${SAMPLE}`,
        [software],
      ),
      await sql.unsafe(
        `select r.ap_id, r.body, r.body_html, r.distinguished, ${at('coalesce(r.posted_at, r.created_at)')} as published, ${at('r.edited_at')} as edited_at,
          l.code as language_code, l.name as language_name, u.ap_profile_id as author, c.ap_profile_id as community, i.software,
          coalesce(parent.ap_id, p.ap_id) as in_reply_to
        from post_reply r join instance i on i.id = r.instance_id join "user" u on u.id = r.user_id join post p on p.id = r.post_id
          join community c on c.id = r.community_id left join post_reply parent on parent.id = r.parent_id left join language l on l.id = r.language_id
        where r.ap_id is not null and not r.deleted and i.software = $1 order by r.id desc limit ${SAMPLE}`,
        [software],
      ),
    ]),
  );
  const posts = samples.flatMap(([sample]) => sample ?? []);
  const comments = samples.flatMap(([, sample]) => sample ?? []);
  const [polls] = await sql.unsafe(`select count(*)::int as count from post where type = 5`);
  return {
    docs: [
      ...localUsers.map(person),
      ...localCommunities.map((row) => community(row, languages, true)),
      ...followed.map((row) => community(row, languages, false)),
      ...posts.map(page),
      ...comments.map(note),
    ],
    notSampled: [`${polls?.count ?? 0} polls (PieFed post type 5, a Question): no mapping yet`],
  };
}

export async function runArchive(url: string): Promise<ArchiveReport> {
  const sql = postgres(url, {
    max: 6,
    onnotice: () => {},
    connection: { default_transaction_read_only: true, application_name: 'fixture-import' },
  });
  try {
    const { docs, notSampled } = await readDocuments(sql);
    const report: ArchiveReport = {
      documents: docs.length,
      bySoftware: new Map(),
      deltas: new Map(),
      unmappable: [],
      undocumented: [],
      notSampled,
    };
    for (const doc of docs) {
      const label = `${doc.kind} ${doc.software}`;
      report.bySoftware.set(label, (report.bySoftware.get(label) ?? 0) + 1);
      let differences;
      try {
        differences = roundTrip(doc.json).differences;
      } catch (error) {
        if (!(error instanceof MappingError)) throw error;
        report.unmappable.push(`${doc.kind} ${doc.id}: ${error.message}`);
        continue;
      }
      const seen = new Set<string>();
      for (const difference of differences) {
        const vocabulary = explain(difference);
        if (vocabulary === undefined) {
          report.undocumented.push(
            `${doc.kind} ${doc.software} ${doc.id}: ${difference.change} ${difference.path} (${JSON.stringify(difference.original)} -> ${JSON.stringify(difference.mapped)})`,
          );
          continue;
        }
        const key = `${vocabulary} ${difference.change} ${doc.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const delta = report.deltas.get(key) ?? {
          vocabulary,
          change: difference.change,
          kind: doc.kind,
          documents: 0,
          software: new Set<string>(),
        };
        delta.documents += 1;
        delta.software.add(doc.software);
        report.deltas.set(key, delta);
      }
    }
    return report;
  } finally {
    await sql.end();
  }
}

/** Why the archive run fails, if it does: documents that could not map and differences no vocabulary entry documents. */
export function archiveFailures(report: Pick<ArchiveReport, 'unmappable' | 'undocumented'>): string[] {
  return [...report.unmappable.map((line) => `unmappable ${line}`), ...report.undocumented.map((line) => `undocumented ${line}`)];
}

/** The schema deltas the archive shows, as a Markdown table (for the lane notes). */
export function deltasTable(report: ArchiveReport): string {
  const lines = [
    `Archive subset: ${report.documents} documents (${[...report.bySoftware].map(([label, count]) => `${count} ${label}`).join(', ')}).`,
    '',
    '| Vocabulary | Change | Kind | Documents | Origin software | Schema |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const rows = [...report.deltas.values()].sort((a, b) => a.vocabulary.localeCompare(b.vocabulary) || a.kind.localeCompare(b.kind));
  for (const delta of rows) {
    const schema = vocabularyByKey.get(delta.vocabulary)?.schema;
    lines.push(
      `| ${delta.vocabulary} | ${delta.change} | ${delta.kind} | ${delta.documents} | ${[...delta.software].sort().join(', ')} | ${schema ? `${schema.kind}: ${schema.detail}` : ''} |`,
    );
  }
  for (const line of report.notSampled) lines.push('', `Not sampled: ${line}`);
  if (report.unmappable.length)
    lines.push('', `Unmappable (${report.unmappable.length}):`, ...report.unmappable.map((line) => `- ${line}`));
  return lines.join('\n');
}
