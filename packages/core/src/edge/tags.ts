import type { Uuid } from '@peblish/schema/ids';

// Cache-Tag values on public proxy answers, so a takedown purges by tag (Cloudflare's free plan
// takes up to 100 tags a request). Every public answer carries ALL_TAG, the wide purge; then the
// content it was signed for and what that content's visibility rests on: a post's community and
// author, a comment's post, the post's author and community, and the comment's author. Purging
// an actor's tag reaches their profile images, their posts and comments, the comments under
// their posts and, for a community, everything in it. Tags are lowercase (Cloudflare ignores case).

/** On every public proxy answer: purging it empties the edge of remote images. */
export const ALL_TAG = 'pbm';

export const postTag = (id: Uuid) => `pbm-p-${id.toLowerCase()}`;
export const commentTag = (id: Uuid) => `pbm-c-${id.toLowerCase()}`;
/** A person or a community. */
export const actorTag = (id: Uuid) => `pbm-a-${id.toLowerCase()}`;

/** What a purge asks for: these tags, or every public proxy answer. */
export type Purge = readonly string[] | 'all';
