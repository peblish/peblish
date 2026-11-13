import { createHash } from 'node:crypto';
import type { Uuid } from '@peblish/schema/ids';
import { hostAndParents } from '../peers/domains.ts';

// Cache-Tag values on public proxy answers, so a takedown purges by tag (Cloudflare takes up to
// 100 tags a request). Every public answer carries ALL_TAG, the wide purge; then the content it
// was signed for and what that content's visibility rests on: a post's community and author, a
// comment's post, the post's author and community, and the comment's author. Purging an actor's
// tag reaches their profile images, their posts and comments, the comments under their posts
// and, for a community, everything in it. It also carries a host tag for its supplier and for
// every host the image was fetched through, at each of their parent domains, so a peer domain
// that becomes denied purges exactly what is at or under it; and a tag for the image's SHA-256,
// so listing a hash purges every copy. Tags are lowercase (Cloudflare ignores case).

/** On every public proxy answer: purging it empties the edge of remote images. */
export const ALL_TAG = 'pbm';
/** The tag the idle check purges: on no answer, so it proves the token and removes nothing. */
export const CHECK_TAG = 'pbm-check';

export const postTag = (id: Uuid) => `pbm-p-${id.toLowerCase()}`;
export const commentTag = (id: Uuid) => `pbm-c-${id.toLowerCase()}`;
/** A person or a community. */
export const actorTag = (id: Uuid) => `pbm-a-${id.toLowerCase()}`;
/** One host or domain (as `instances.domain` writes it), hashed so a tag is short and plain ASCII. */
export const hostTag = (host: string) => `pbm-h-${createHash('sha256').update(host.toLowerCase()).digest('hex').slice(0, 32)}`;
/** `host` and every parent domain of it, so purging any of them reaches it. */
export const hostTags = (host: string) => hostAndParents(host.toLowerCase()).map(hostTag);
/** An image by its exact SHA-256, lowercase hex (as the blocked-image list holds it). */
export const hashTag = (sha256: string) => `pbm-x-${sha256.toLowerCase()}`;

/** What a purge asks for: these tags, or every public proxy answer. */
export type Purge = readonly string[] | 'all';
