import type { ActorRef, CommentView, PostView } from '@peblish/schema/views';

// Sample data for the gallery, typed against the real view models. The clock is fixed so the
// server and the browser print the same ages.
export const now = new Date('2026-11-09T12:00:00Z');
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

let actors = 0;
const actor = (name: string, host: string | null, kind: 'Person' | 'Group'): ActorRef => ({
  id: `00000000-0000-7000-9000-${String(++actors).padStart(12, '0')}`,
  apId: `https://${host ?? 'feddit.test'}/${kind === 'Group' ? 'c' : 'u'}/${name}`,
  kind,
  name,
  displayName: null,
  local: host === null,
  handle: host === null ? name : `${name}@${host}`,
});

export const people = {
  jun: actor('jun', 'lemmy.world', 'Person'),
  andrew: actor('andrew', null, 'Person'),
  mira: actor('mira', null, 'Person'),
  kofi: actor('kofi', 'fedia.io', 'Person'),
};
export const communities = {
  fediverse: actor('fediverse', 'lemmy.world', 'Group'),
  announcements: actor('announcements', null, 'Group'),
  art: actor('art', null, 'Group'),
};

/**
 * A hatched picture as a data URI, so the gallery loads nothing from the network. It stands for
 * what a page gets from the renderer's image() helper for a thumbnail: PostCard shows only that
 * resolved source, never the post's own thumbnailUrl (see thumbnailSrc below).
 */
const picture =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='90'%3E%3Cdefs%3E%3Cpattern id='p' width='8' height='8' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'%3E%3Crect width='4' height='8' fill='%23888'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='160' height='90' fill='url(%23p)'/%3E%3C/svg%3E";

/** What a feed loader would pass PostCard as `thumbnailSrc`: the post's thumbnail, resolved (here a local picture) or null. */
export const thumbnailSrc = (post: PostView): string | null => (post.thumbnailUrl ? picture : null);

/** The host of the thumbnail the withheld post names; e2e asserts nothing is requested from it. */
export const withheldHost = 'tracker.example';

let counter = 0;
const base = (title: string, over: Partial<PostView>): PostView => ({
  id: `00000000-0000-7000-8000-${String(++counter).padStart(12, '0')}`,
  apId: `https://feddit.test/post/${counter}`,
  title,
  url: null,
  urlContentType: null,
  thumbnailUrl: null,
  contentHtml: null,
  excerpt: null,
  author: people.jun,
  authorBadge: null,
  community: communities.fediverse,
  publishedAt: ago(3),
  editedAt: null,
  sensitive: false,
  nsfl: false,
  locked: false,
  featured: false,
  deleted: false,
  removed: false,
  counts: { upvotes: 860, downvotes: 18, comments: 148 },
  myVote: 0,
  ...over,
});

export const posts = {
  link: base('Lemmy 1.0 changes how Lock and Flag federate: what to test on Mbin and PieFed', {
    url: 'https://www.join-lemmy.org/news/lock-and-flag',
    thumbnailUrl: 'https://www.join-lemmy.org/assets/lock-and-flag.png',
  }),
  pinned: base('Welcome to feddit.com on peblish: what changed and what did not', {
    community: communities.announcements,
    author: people.andrew,
    authorBadge: 'admin',
    publishedAt: ago(24),
    featured: true,
    excerpt:
      'Same domain, same actors, new software. Registration is by invite only for now, capped at 25 people for 30 days. Your follows carry over; old posts did not migrate.',
    counts: { upvotes: 311, downvotes: 0, comments: 57 },
    myVote: 1,
  }),
  text: base('Which sort do you leave your home feed on?', {
    community: communities.art,
    author: people.mira,
    authorBadge: 'moderator',
    publishedAt: ago(14),
    excerpt:
      'Hot gets stale for me after lunch, New is noisy, Top of day hides small communities. Curious what other people settle on and why.',
    counts: { upvotes: 24, downvotes: 1, comments: 61 },
    myVote: -1,
  }),
  image: base('Rack day: finally labelled every cable', {
    url: 'https://lemmy.ml/pictrs/image/rack.jpg',
    urlContentType: 'image/jpeg',
    thumbnailUrl: 'https://lemmy.ml/pictrs/image/rack-thumb.jpg',
    publishedAt: ago(30),
    counts: { upvotes: 410, downvotes: 0, comments: 27 },
  }),
  nsfw: base('Week 12 life drawing: hands, again', {
    community: communities.art,
    author: people.mira,
    authorBadge: 'moderator',
    url: 'https://feddit.test/media/hands.png',
    urlContentType: 'image/png',
    thumbnailUrl: 'https://feddit.test/media/hands-thumb.png',
    sensitive: true,
    excerpt: 'Charcoal on newsprint, forty minutes.',
    publishedAt: ago(8),
    counts: { upvotes: 95, downvotes: 0, comments: 12 },
  }),
  /** A remote thumbnail the page chose not to load (remote media off): the card must show its type mark and request nothing. */
  withheld: base('A link whose picture is not loaded', {
    url: 'https://news.example/story',
    thumbnailUrl: `https://${withheldHost}/pixel.png`,
  }),
};

export const feed = [posts.pinned, posts.link, posts.nsfw, posts.text, posts.image];

type CommentOptions = Partial<Pick<CommentView, 'removed' | 'deleted' | 'authorBadge' | 'editedAt' | 'myVote'>> & {
  author?: ActorRef;
  score?: number;
  replies?: number;
};

/** A comment view without its body, and the Markdown the server renders into `contentHtml`. */
export interface CommentSample {
  view: CommentView;
  source: string | null;
}

const comment = (
  id: string,
  parentId: string | null,
  depth: number,
  source: string | null,
  options: CommentOptions = {},
): CommentSample => {
  const { author = people.kofi, score = 12, replies = 0, ...flags } = options;
  return {
    source,
    view: {
      id,
      apId: `https://feddit.test/comment/${id}`,
      postId: posts.link.id,
      parentId,
      depth,
      contentHtml: null,
      author,
      authorBadge: null,
      publishedAt: ago(2),
      editedAt: null,
      deleted: false,
      removed: false,
      counts: { upvotes: Math.max(score, 0), downvotes: Math.max(-score, 0), comments: replies },
      myVote: 0,
      ...flags,
    },
  };
};

/** A varied thread: the post's author (OP), a moderator, a low-score comment with replies, a removed one, a deleted one. */
export const threadSamples: CommentSample[] = [
  comment('c1', null, 0, 'OP here. Short version: **Lock** moves to a first class `Lock` activity.', {
    author: people.jun,
    score: 214,
    replies: 4,
  }),
  comment('c1a', 'c1', 1, 'Pinned the test checklist in the sidebar.', {
    author: people.mira,
    authorBadge: 'moderator',
    score: 188,
    replies: 3,
  }),
  comment('c1a1', 'c1a', 2, 'Mbin already accepts both forms.', { score: 61, replies: 2 }),
  comment('c1a1a', 'c1a1', 3, 'Rejected how? PieFed retries on 5xx for a day.', { author: people.jun, score: 30, replies: 1 }),
  comment('c1a1a1', 'c1a1a', 4, '400, no retry. It shows up in the peer panel.', { score: 22, replies: 5 }),
  comment('c1b', null, 0, 'Buy followers cheap.', { score: -9, replies: 1 }),
  comment('c1b1', 'c1b', 1, 'Reported.', { score: -2 }),
  comment('c1c', null, 0, null, { removed: true, score: 0 }),
  comment('c1d', null, 0, null, { deleted: true, score: 0 }),
  comment('c1e', null, 0, 'Edited once.', { editedAt: ago(1), score: 4 }),
];

/** A 50-level chain, the deepest thread the server allows. */
export const deepThreadSamples: CommentSample[] = Array.from({ length: 50 }, (_, index) =>
  comment(`d${index + 1}`, index === 0 ? null : `d${index}`, index, `Reply at depth ${index + 1}.`, {
    score: 3,
    replies: 49 - index,
  }),
);

/** The views with their bodies rendered by `render`: the server's Markdown renderer, as a thread page uses it. */
export const withBodies = (samples: CommentSample[], render: (source: string, id: string) => string): CommentView[] =>
  samples.map(({ view, source }) => ({ ...view, contentHtml: source === null ? null : render(source, view.id) }));

/** Markdown for the content styles: every element and class the Markdown pipeline emits, rendered by the server. */
export const proseMarkdown = `
## Heading two

Plain text with *emphasis*, **strong**, \`inline code\`, ^sup^ and ~sub~, ~~struck~~, a [link](/kit) and a mention @jun@lemmy.world.

> A quotation that is long enough to wrap onto a second line on a narrow screen, to show the bar.

\`\`\`ts
const answer: number = 42; // code face
function greet(name: string) { return \`hello \${name}\`; }
\`\`\`

::: spoiler Spoiler title
The body stays closed until it is opened.
:::

| Left | Centre | Right |
| :--- | :----: | ----: |
| a | b | c |

A footnote reference[^1].

[^1]: The footnote text.
`;

/**
 * A remote object's HTML (a PieFed or Mastodon post), which the server sanitises: inline
 * spoilers (one holding a link, which stays a plain span) and Mastodon's shortened link.
 */
export const proseRemoteHtml = `<p>A <tg-spoiler>hidden spoiler</tg-spoiler> inside a sentence, a second <span class="spoiler">spoiler</span>, one that holds a <span class="spoiler">linked <a href="https://example.com/x">word</a></span>, and a short link <a href="https://example.com/a/long/path"><span class="invisible">https://</span><span class="ellipsis">example.com/a/long</span><span class="invisible">/path</span></a>.</p>`;
