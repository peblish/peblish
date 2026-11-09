// Owned by lane E2. Browser-safe: the shell's badge imports these, so nothing here touches the database.

/** What a notice is about: a reply or mention, a moderator's removal or restore of the person's content, a ban or unban. */
export const notificationKinds = ['reply', 'mention', 'mod_remove', 'mod_restore', 'ban', 'unban'] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/** unreadCount stops counting here; the badge prints "99+" at the cap. */
export const unreadCap = 100;

/** The inbox's filter links (`?filter=`), in the order the page lists them. */
export const inboxFilters = ['all', 'unread', 'replies', 'mentions', 'content', 'account'] as const;
export type InboxFilter = (typeof inboxFilters)[number];

/** The kinds each filter lists. Unread lists every kind and keeps the unread ones. */
export const filterKinds = {
  all: notificationKinds,
  unread: notificationKinds,
  replies: ['reply'],
  mentions: ['mention'],
  content: ['mod_remove', 'mod_restore'],
  account: ['ban', 'unban'],
} as const satisfies Record<InboxFilter, readonly NotificationKind[]>;

/** Why a notice shows a word instead of the text: sensitive content for every viewer, or a comment removed or deleted since. */
export type NoticeWithheld = 'sensitive' | 'removed' | 'deleted';

/** A person or community in a notice (browser-safe copy of the schema's ActorRef fields the row prints). */
export type NoticeActor = { id: string; name: string; displayName: string | null; handle: string; local: boolean };

/** The moderator's statement of reasons behind a removal, restore, ban or unban. */
export type NoticeStatement = {
  modlogId: string;
  /** Null when none was given or the issuing instance is not trusted (`reasonWithheld`). */
  reason: string | null;
  reasonWithheld: boolean;
  /** Only a public entry has a page at /modlog/<id> to link to. */
  public: boolean;
};

export type InboxItem = {
  id: string;
  kind: NotificationKind;
  read: boolean;
  createdAt: string;
  /** Who did it: the replier, the mentioner, the moderator. Null once their row is gone. */
  actor: NoticeActor | null;
  community: NoticeActor | null;
  postId: string | null;
  commentId: string | null;
  /** The post's title; null when the post is gone or the notice is sensitive. */
  postTitle: string | null;
  /** What the notice's text is: the comment (when commentId is set) or the post. Null for a ban. */
  about: 'post' | 'comment' | null;
  /** For a reply: whether it answers a post or a comment of the viewer's. */
  replyTo: 'post' | 'comment' | null;
  withheld: NoticeWithheld | null;
  /** Plain text, a few lines at most; null when withheld, empty or not about content. */
  excerpt: string | null;
  statement: NoticeStatement | null;
};

/** Unread notices per filter group, each counted up to unreadCap. */
export type UnreadByGroup = { replies: number; mentions: number; content: number; account: number };

export type Inbox = { items: InboxItem[]; next: string | null; unread: number; unreadByGroup: UnreadByGroup };
