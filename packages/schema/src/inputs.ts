import { type } from 'arktype';
import { Uuid } from './ids.ts';
import { SiteWidth } from './site-settings.ts';

// What the Commons features take from a person: saves, pins, thread follows, the width
// preset, post search and series. Shapes only; each feature's service authorises the subject
// and takes its ids from the grant. Publishing the banner takes banner.ts's BannerPublish.

/** Save or unsave a post (owner-only). */
export const SavePost = type({ postId: Uuid });
export type SavePost = typeof SavePost.infer;

/** Pin or unpin a community in the viewer's sidebar (owner-only). */
export const PinCommunity = type({ communityId: Uuid });
export type PinCommunity = typeof PinCommunity.infer;

/** Move a pinned community to another place in the viewer's order. */
export const MovePin = type({ communityId: Uuid, toPosition: 'number.integer >= 0' });
export type MovePin = typeof MovePin.infer;

/** Follow or stop following a thread (owner-only). */
export const WatchPost = type({ postId: Uuid });
export type WatchPost = typeof WatchPost.infer;

/** Set the site's width preset (`site.width`). */
export const SetWidth = type({ width: SiteWidth });
export type SetWidth = typeof SetWidth.infer;

/** A post search: `q` trimmed, 2 to 100 characters; `cursor` is the previous page's `nextCursor`. */
export const SearchQuery = type({ q: type('string.trim').to('2 <= string <= 100'), cursor: 'string | null = null' });
export type SearchQuery = typeof SearchQuery.infer;

/** Part of creating a post: append it after its predecessor in the author's series; `title` names the series. */
export const SeriesAppend = type({ predecessorPostId: Uuid, 'title?': type('string.trim').to('1 <= string <= 200') });
export type SeriesAppend = typeof SeriesAppend.infer;
