import type { ActorRef } from '@peblish/schema/views';

// Where things live, in one place, so a lane that moves a page changes one line. The actor
// pages `/u/<handle>` and `/c/<handle>` are also the actors' ActivityPub ids (README, web rules).

/** A handle in a path: `name` for a local actor, `name@host` for a remote one, with the @ kept readable. */
const handlePath = (handle: string) => encodeURIComponent(handle).replaceAll('%40', '@');

export const postPath = (postId: string) => `/post/${postId}`;
/** The "Continue this thread" permalink: one comment and what is under it. */
export const commentPath = (postId: string, commentId: string) => `/post/${postId}/comments/${commentId}`;
export const communityPath = ({ handle }: Pick<ActorRef, 'handle'>) => `/c/${handlePath(handle)}`;
export const userPath = ({ handle }: Pick<ActorRef, 'handle'>) => `/u/${handlePath(handle)}`;

/** The feeds in the sidebar (lane C1 builds the pages). `/` is Subscribed when signed in, Local when signed out. */
export const feedPaths = { subscribed: '/', local: '/local', all: '/all', popular: '/popular', moderating: '/moderating' } as const;

/** The directory and the resolver (lane DISC). */
export const directoryPaths = { browse: '/communities', find: '/resolve' } as const;

/** The site's own pages (lane ADM). */
export const sitePaths = { rules: '/rules', terms: '/terms', privacy: '/privacy', about: '/about' } as const;

export const createPostPath = '/submit';
