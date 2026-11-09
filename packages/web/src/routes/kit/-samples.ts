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

const comment = (id: string, parentId: string | null, depth: number, html: string | null, options: CommentOptions = {}): CommentView => {
  const { author = people.kofi, score = 12, replies = 0, ...flags } = options;
  return {
    id,
    apId: `https://feddit.test/comment/${id}`,
    postId: posts.link.id,
    parentId,
    depth,
    contentHtml: html,
    author,
    authorBadge: null,
    publishedAt: ago(2),
    editedAt: null,
    deleted: false,
    removed: false,
    counts: { upvotes: Math.max(score, 0), downvotes: Math.max(-score, 0), comments: replies },
    myVote: 0,
    ...flags,
  };
};

/** A varied thread: the post's author (OP), a moderator, a low-score comment with replies, a removed one, a deleted one. */
export const thread: CommentView[] = [
  comment('c1', null, 0, '<p>OP here. Short version: <b>Lock</b> moves to a first class <code>Lock</code> activity.</p>', {
    author: people.jun,
    score: 214,
    replies: 4,
  }),
  comment('c1a', 'c1', 1, '<p>Pinned the test checklist in the sidebar.</p>', {
    author: people.mira,
    authorBadge: 'moderator',
    score: 188,
    replies: 3,
  }),
  comment('c1a1', 'c1a', 2, '<p>Mbin already accepts both forms.</p>', { score: 61, replies: 2 }),
  comment('c1a1a', 'c1a1', 3, '<p>Rejected how? PieFed retries on 5xx for a day.</p>', { author: people.jun, score: 30, replies: 1 }),
  comment('c1a1a1', 'c1a1a', 4, '<p>400, no retry. It shows up in the peer panel.</p>', { score: 22, replies: 5 }),
  comment('c1b', null, 0, '<p>Buy followers cheap.</p>', { score: -9, replies: 1 }),
  comment('c1b1', 'c1b', 1, '<p>Reported.</p>', { score: -2 }),
  comment('c1c', null, 0, null, { removed: true, score: 0 }),
  comment('c1d', null, 0, null, { deleted: true, score: 0 }),
  comment('c1e', null, 0, '<p>Edited once.</p>', { editedAt: ago(1), score: 4 }),
];

/** A 50-level chain, the deepest thread the server allows. */
export const deepThread: CommentView[] = Array.from({ length: 50 }, (_, index) =>
  comment(`d${index + 1}`, index === 0 ? null : `d${index}`, index, `<p>Reply at depth ${index + 1}.</p>`, {
    score: 3,
    replies: 49 - index,
  }),
);

/** HTML the Markdown pipeline emits, for the content styles. */
export const proseSample = `
<h2>Heading two</h2>
<p>Plain text with <em>emphasis</em>, <strong>strong</strong>, <code>inline code</code>, <sup>sup</sup> and <sub>sub</sub>, a <a href="/kit">link</a>, <a class="u-url mention" href="/u/jun@lemmy.world">@jun@lemmy.world</a> and an emoji <img class="emoji" alt=":smile:" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23fc0'/%3E%3C/svg%3E">.</p>
<blockquote><p>A quotation that is long enough to wrap onto a second line on a narrow screen, to show the bar.</p></blockquote>
<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> answer: <span class="hljs-built_in">number</span> = <span class="hljs-number">42</span>; <span class="hljs-comment">// code face</span>
<span class="hljs-keyword">function</span> <span class="hljs-title function_">greet</span>(<span class="hljs-params">name</span>) { <span class="hljs-keyword">return</span> <span class="hljs-string">\`hello \${name}\`</span>; }</code></pre>
<p>A <span class="spoiler">hidden spoiler</span> inside a sentence, and a short link <a href="https://example.com/a/long/path"><span class="invisible">https://</span><span class="ellipsis">example.com/a/long</span></a>.</p>
<details><summary>Spoiler title</summary><p>The body stays closed until it is opened.</p></details>
<table><thead><tr><th align="left">Left</th><th align="center">Centre</th><th align="right">Right</th></tr></thead><tbody><tr><td align="left">a</td><td align="center">b</td><td align="right">c</td></tr></tbody></table>
<p>A footnote reference<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>.</p>
<hr class="footnotes-sep">
<section class="footnotes"><ol class="footnotes-list"><li id="fn1"><p>The footnote text. <a href="#fnref1" class="footnote-backref">back</a></p></li></ol></section>
`;
