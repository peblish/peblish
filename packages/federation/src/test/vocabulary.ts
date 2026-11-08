import type { Change } from './diff.ts';

// The documented vocabulary: every way a wire document may differ after a round trip
// through the mapping (wire, record, wire). A manifest entry may only allow a difference
// that one of these entries names. `schema` says what root should do about a field the
// records cannot hold: a column or table (a schema delta for a migration), keep it in
// `raw` only, or nothing because peblish derives it, already stores it or does not use it.

export type Vocabulary = {
  key: string;
  /** Globs over diff paths with array indices removed: `*` is one key, `**.` any leading keys. */
  paths: string[];
  changes: Change[];
  note: string;
  schema: { kind: 'column' | 'table' | 'raw' | 'none'; detail: string };
};

const none = (detail: string) => ({ kind: 'none', detail }) as const;
const raw = (detail: string) => ({ kind: 'raw', detail }) as const;
const column = (detail: string) => ({ kind: 'column', detail }) as const;
const table = (detail: string) => ({ kind: 'table', detail }) as const;

export const vocabulary: Vocabulary[] = [
  // What peblish sends on purpose (the Lemmy vocabulary of the outbound mapping).
  {
    key: 'peblish.context',
    paths: ['@context', '**.@context'],
    changes: ['changed'],
    note: "peblish sends Lemmy's @context on the top-level document only; PieFed and Fedify send their own",
    schema: none('constant'),
  },
  {
    key: 'peblish.context.embedded',
    paths: ['**.@context'],
    changes: ['dropped'],
    note: 'An embedded activity carries no @context of its own (Lemmy relays Fedify JSON with one)',
    schema: none('constant'),
  },
  {
    key: 'lemmy.stored-without-context',
    paths: ['@context'],
    changes: ['added'],
    note: "Lemmy's sent_activity table keeps activities without @context, which it adds when sending",
    schema: none('constant'),
  },
  {
    key: 'peblish.page-flags',
    paths: ['commentsEnabled', 'stickied', '**.commentsEnabled', '**.stickied'],
    changes: ['added'],
    note: 'peblish always sends commentsEnabled and stickied; Lemmy 0.19 and Fedify leave them out',
    schema: none('posts.locked and posts.featured_community'),
  },
  {
    key: 'peblish.attachment',
    paths: ['attachment', '**.attachment'],
    changes: ['added'],
    note: 'peblish sends attachment on every Page and Note, an empty array when there is no link (Lemmy does)',
    schema: none('posts.url'),
  },
  {
    key: 'peblish.distinguished',
    paths: ['distinguished', '**.distinguished'],
    changes: ['added'],
    note: 'peblish sends distinguished on every Note (Lemmy does; Fedify does not)',
    schema: none('comments.distinguished'),
  },
  {
    key: 'peblish.page-cc',
    paths: ['cc', '**.cc'],
    changes: ['added'],
    note: 'peblish sends cc on every Page and Note (Lemmy requires it); Fedify leaves an empty cc out',
    schema: none('derived from the community'),
  },
  {
    key: 'peblish.media-type',
    paths: ['mediaType', '**.mediaType'],
    changes: ['added'],
    note: 'peblish always labels content text/html',
    schema: none('constant'),
  },
  {
    key: 'peblish.addressing',
    paths: ['to', 'cc', '**.to', '**.cc'],
    changes: ['changed'],
    note: "Addressing is derived from the community: Lemmy adds a reply's parent author to cc, PieFed copies the object's to and cc onto the activity",
    schema: none('derived'),
  },
  {
    key: 'peblish.language-name',
    paths: ['language.name', '**.language.name', 'language[].name', '**.language[].name'],
    changes: ['changed'],
    note: "The language's own name is derived from its code (Intl); peers spell some differently",
    schema: none('derived from posts.language, comments.language and community_languages'),
  },
  {
    key: 'peblish.nsfl',
    paths: ['nsfl', '**.nsfl'],
    changes: ['added'],
    note: 'peblish sends nsfl (not safe for life) on every Page and Group, as PieFed does on Pages; Lemmy and Fedify leave it out',
    schema: none('posts.nsfl and actors.nsfl'),
  },
  {
    key: 'peblish.search-consent',
    paths: ['discoverable', 'indexable', '**.discoverable', '**.indexable'],
    changes: ['added'],
    note: 'peblish sends discoverable and indexable on every actor, because Mastodon reads an absent flag as an opt-out; Lemmy leaves both out, read as true',
    schema: none('actors.discoverable and actors.indexable'),
  },
  {
    key: 'peblish.web-url',
    paths: ['attachment[]', '**.attachment[]', 'image', '**.image'],
    changes: ['dropped'],
    note: "A post's link or preview image that is not http(s) (javascript:, data:, file:) is dropped, not the post",
    schema: none('posts.url and posts.thumbnail_url hold http(s) URLs only'),
  },

  // Fields peers send that the records do not hold.
  {
    key: 'tags',
    paths: ['tag', '**.tag', 'tag[]', '**.tag[]'],
    changes: ['dropped'],
    note: "Mention tags (Lemmy and PieFed replies), the community hashtag Lemmy adds to Pages, PieFed's post and community tags",
    schema: table('mentions and hashtags: no table yet; kept in raw'),
  },
  {
    key: 'lemmy.announce-page-actor',
    paths: ['object.actor'],
    changes: ['dropped'],
    note: 'Lemmy adds the author as actor to the Page in its Announce(Page) for Mastodon; attributedTo already names them',
    schema: none('duplicate of attributedTo'),
  },
  {
    key: 'fedify.note-sensitive',
    paths: ['**.sensitive'],
    changes: ['dropped'],
    note: 'Fedify marks Notes sensitive: false; a comment has no flag of its own (it follows its post)',
    schema: none('comments follow posts.sensitive'),
  },
  {
    key: 'piefed.gen-ai',
    paths: ['genAI', '**.genAI'],
    changes: ['dropped'],
    note: 'PieFed: the post (or the community) is AI-generated',
    schema: raw('posts.gen_ai and actors.gen_ai only if peblish filters on it'),
  },
  {
    key: 'piefed.interaction-policy',
    paths: ['interactionPolicy', '**.interactionPolicy'],
    changes: ['dropped'],
    note: "GoToSocial's quote policy, which PieFed sends on every Page",
    schema: none('peblish allows no quote posts'),
  },
  {
    key: 'piefed.flair',
    paths: ['flair', '**.flair'],
    changes: ['dropped'],
    note: "PieFed: the author's user flair in the community, on each Note",
    schema: raw('community user flair is not in Phase 1'),
  },
  {
    key: 'piefed.content-map',
    paths: ['contentMap', '**.contentMap'],
    changes: ['dropped'],
    note: 'PieFed and Mbin repeat content under its language code',
    schema: none('derived from content and language'),
  },
  {
    key: 'piefed.url',
    paths: ['url', '**.url'],
    changes: ['dropped'],
    note: 'PieFed sends the object or actor id again as url (the human page)',
    schema: none('ap_ids are the human pages (contract 6)'),
  },
  {
    key: 'piefed.moderators',
    paths: ['moderators'],
    changes: ['dropped'],
    note: 'PieFed names the moderators collection twice, in attributedTo and moderators',
    schema: none('actors.moderators_url'),
  },
  {
    key: 'piefed.total-items',
    paths: ['totalItems'],
    changes: ['dropped'],
    note: 'PieFed counts the moderators collection',
    schema: none('derived'),
  },
  {
    key: 'piefed.end-time',
    paths: ['endTime', '**.endTime'],
    changes: ['dropped'],
    note: 'PieFed sends a ban expiry as both expires and endTime',
    schema: none('same value as expires'),
  },
  {
    key: 'piefed.community-settings',
    paths: [
      'contentRetention',
      'defaultHashtag',
      'defaultPostType',
      'postUrlType',
      'questionAnswer',
      'newModsWanted',
      'privateMods',
      'lemmy:tagsForPosts',
    ],
    changes: ['dropped'],
    note: 'PieFed community settings: content retention, default hashtag and post type, URL style, Q&A mode, wanting moderators, private moderator list, post tags',
    schema: raw('PieFed-only behaviour; privateMods matters if peblish lists moderators'),
  },
  {
    key: 'piefed.person-settings',
    paths: ['acceptPrivateMessages', 'attributionDomains', 'manuallyApprovesFollowers', 'reposter'],
    changes: ['dropped'],
    note: 'PieFed: who may send private messages, FEP attribution domains, follow approval, and the reposter (bot-like) flag',
    schema: raw('private messages and follow approval are not in Phase 1; reposter could set actors.bot'),
  },
];

export const vocabularyByKey = new Map(vocabulary.map((entry) => [entry.key, entry]));
