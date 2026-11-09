// Owned by lane E2. Browser-safe: the shell's badge imports these, so nothing here touches the database.

/** What a notice is about: a reply or mention, a moderator's removal or restore of the person's content, a ban or unban. */
export const notificationKinds = ['reply', 'mention', 'mod_remove', 'mod_restore', 'ban', 'unban'] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/** unreadCount stops counting here; the badge prints "99+" at the cap. */
export const unreadCap = 100;
