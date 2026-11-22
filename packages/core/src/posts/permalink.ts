import type { Uuid } from '@peblish/schema/ids';

// The absolute addresses of discussions on this server: PostView.permalink and CommentView.permalink.
// Built from ids only, so they never carry an author's handle, a title or the viewer's state;
// web's shell/paths.ts builds the same paths (postPath, commentPath), and its test holds the two together.

export const postPermalink = (origin: string, postId: Uuid) => `${origin}/post/${postId}`;
export const commentPermalink = (origin: string, postId: Uuid, commentId: Uuid) => `${origin}/post/${postId}/comments/${commentId}`;
