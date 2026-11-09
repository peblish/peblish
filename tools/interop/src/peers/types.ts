// What a scenario can ask of a peer. Lemmy and PieFed share one API shape (peers/threadiverse.ts);
// Mbin has its own (peers/mbin.ts). An action a peer cannot do throws NotApplicable.

export type PeerName = 'lemmy' | 'piefed' | 'mbin';

export type PeerPost = {
  id: number;
  apId: string;
  title: string;
  body: string | null;
  url: string | null;
  creatorApId: string;
  score: number;
  deleted: boolean;
  removed: boolean;
  locked: boolean;
  featured: boolean;
};

export type PeerComment = {
  id: number;
  apId: string;
  content: string;
  /** Lemmy's ltree path, PieFed's path; Mbin has the parent id instead. */
  path: string;
  parentId: number | null;
  creatorApId: string;
  deleted: boolean;
  removed: boolean;
};

export type Subscription = 'Subscribed' | 'Pending' | 'NotSubscribed';

/** Moderator and reporting calls. */
export type PeerModeration = {
  resolvePerson(token: string, actorUri: string): Promise<number>;
  removePost(token: string, postId: number, removed: boolean, reason: string): Promise<void>;
  lockPost(token: string, postId: number, locked: boolean): Promise<void>;
  featurePost(token: string, postId: number, featured: boolean): Promise<void>;
  ban(token: string, communityId: number, personId: number, ban: boolean, reason: string): Promise<void>;
  reportPost(token: string, postId: number, reason: string): Promise<void>;
  /** Actor ids the peer lists as moderators of one of its communities (local or remote). */
  moderators(token: string, communityId: number): Promise<string[]>;
  /** Makes a person a moderator of a community on this peer (admin or owner token). */
  addModerator(token: string, communityId: number, personId: number, add: boolean): Promise<void>;
};

export type Peer = {
  /** Label in scenario output. */
  readonly name: PeerName;
  readonly origin: string;
  /** The seeded ordinary user and admin. */
  readonly user: string;
  readonly admin: string;
  /** The seeded community's local name; its handle is `!<community>@<host>`. */
  readonly community: string;
  /** `https://host/u/name`, as the peer's own users appear in activities. */
  actorUri(username: string): string;
  /** `!name@host`. */
  communityHandle(): string;
  login(username: string): Promise<string>;
  resolveCommunity(token: string, handle: string): Promise<{ id: number; subscribed: Subscription }>;
  follow(token: string, communityId: number): Promise<string>;
  unfollow(token: string, communityId: number): Promise<string>;
  createCommunity(token: string, name: string, title: string): Promise<number>;
  listPosts(token: string, communityId: number): Promise<PeerPost[]>;
  getPost(token: string, postId: number): Promise<PeerPost>;
  resolvePost(token: string, apId: string): Promise<PeerPost | null>;
  createPost(
    token: string,
    communityId: number,
    title: string,
    body: string,
    options?: { url?: string; nsfw?: boolean },
  ): Promise<PeerPost>;
  editPost(token: string, postId: number, title: string, body: string): Promise<void>;
  deletePost(token: string, postId: number): Promise<void>;
  listComments(token: string, postId: number): Promise<PeerComment[]>;
  comment(token: string, postId: number, parentId: number | null, content: string): Promise<PeerComment>;
  editComment(token: string, commentId: number, content: string): Promise<void>;
  deleteComment(token: string, commentId: number): Promise<void>;
  votePost(token: string, postId: number, score: -1 | 0 | 1): Promise<void>;
  voteComment(token: string, commentId: number, score: -1 | 0 | 1): Promise<void>;
  /** The caller's own vote on a post, from the peer (the cleanup ledger reads this). */
  myPostVote(token: string, postId: number): Promise<-1 | 0 | 1>;
  /** The community's local edit (Update(Group) to followers). */
  editCommunity(token: string, communityId: number, title: string, description: string): Promise<void>;
  /** Deletes the caller's own account; `deleteContent` is Lemmy's "delete my content". */
  deleteAccount(token: string, password: string, deleteContent: boolean): Promise<void>;
  readonly mod: PeerModeration;
};
