import { type } from 'arktype';

/**
 * Every kind of notice in the inbox. The first six are what core stores today (core's
 * notifications/view.ts and the table's CHECK). Two are contracts only until the notification
 * feature writes them: `follow_accept`, a remote community accepted the viewer's request to join
 * (the Account filter); `thread_reply`, a new comment in a thread the viewer follows (the Replies
 * filter; never a second notice for a comment that already made a `reply` or `mention`).
 */
export const noticeKinds = ['reply', 'mention', 'mod_remove', 'mod_restore', 'ban', 'unban', 'follow_accept', 'thread_reply'] as const;
export const NoticeKind = type.enumerated(...noticeKinds);
export type NoticeKind = typeof NoticeKind.infer;
