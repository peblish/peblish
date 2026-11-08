// Shared helpers for the seed and scenario scripts. They run in the `runner`
// container on the lab network and reach every peer through Caddy at
// https://<name>.lab.test.
import { writeFileSync } from "node:fs";

export const FEDDIT = "https://feddit.lab.test";
export const LEMMY = "https://lemmy.lab.test";
export const PIEFED = "https://piefed.lab.test";

export const PASSWORD = "lab-password-1";

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function http<T>(
  method: "GET" | "POST" | "PUT",
  url: string,
  options: { body?: unknown; token?: string; query?: Record<string, string | number> } = {},
): Promise<T> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {})) target.searchParams.set(key, String(value));
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(target, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status, text, `${method} ${target.pathname} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `probe` returns a truthy value; throws with the last error on timeout. */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  { timeoutMs = 45_000, intervalMs = 1_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (last error: ${String(lastError)})` : ""}`);
}

// ------------------------------------------------------------------ results

export interface Result {
  scenario: string;
  peer: string;
  /** `known`: failed the way a documented peer defect predicts (see RESULT.md). */
  status: "pass" | "fail" | "n/a" | "known";
  seconds: number;
  note: string;
}

/** Thrown by a scenario the peer cannot perform at all (not a failure). */
export class NotApplicable extends Error {}

/** Runs named scenarios, prints one line each, and writes captures/<file>. */
export function recorder(only?: string[]) {
  const results: Result[] = [];
  return {
    results,
    /**
     * `knownDefect` marks a documented peer defect: a failure is recorded as
     * `known` with that explanation (not failing the run); a pass means the
     * peer has been fixed.
     */
    async scenario(id: string, peer: string, run: () => Promise<string | void>, knownDefect?: string): Promise<boolean> {
      if (only && !only.includes(id)) return true;
      const started = Date.now();
      const done = (status: Result["status"], note: string) => {
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        results.push({ scenario: id, peer, status, seconds, note });
        console.log(`${status.toUpperCase().padEnd(5)} ${id.padEnd(4)} ${peer.padEnd(7)} ${seconds}s ${note}`);
      };
      try {
        done("pass", (await run()) ?? "");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof NotApplicable) done("n/a", message);
        else if (knownDefect) done("known", `${knownDefect} (${message})`);
        else done("fail", message);
        return false;
      }
    },
    finish(file: string, run: string): never {
      writeFileSync(
        new URL(`../captures/${file}`, import.meta.url),
        `${JSON.stringify({ run, at: new Date().toISOString(), results }, null, 2)}\n`,
      );
      const count = (status: Result["status"]) => results.filter((r) => r.status === status).length;
      const failed = count("fail");
      const extra = [count("known") && `${count("known")} known peer defect(s)`, count("n/a") && `${count("n/a")} n/a`].filter(Boolean);
      console.log(`\n${count("pass")}/${results.length - count("n/a")} passed${extra.length ? `, ${extra.join(", ")}` : ""}; results in captures/${file}`);
      process.exit(failed > 0 ? 1 : 0);
    },
  };
}

export const runId = () => new Date().toISOString().slice(5, 19).replace(/[-:T]/g, "");

// ------------------------------------------------------------------ Feddit

export interface FedditObject {
  id: string;
  uri: string;
  kind: "Page" | "Note";
  local: boolean;
  author_uri: string;
  community_uri: string | null;
  in_reply_to: string | null;
  title: string | null;
  content_html: string;
  source_md: string | null;
  link_url: string | null;
  deleted: boolean;
  removed: boolean;
  removed_reason: string | null;
  locked: boolean;
  stickied: boolean;
  via: string;
}

export interface InboxEntry {
  id: string;
  activity_id: string;
  type: string;
  actor: string;
  object: string;
  via: "direct" | "announce";
  outcome: string;
}

export interface OutboxEntry {
  id: string;
  activity_id: string;
  activity_type: string;
  object_id: string | null;
  sender: string;
  inbox: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status: number | null;
  last_error: string | null;
}

export interface FedditState {
  objects: FedditObject[];
  votes: { voter_uri: string; object_uri: string; kind: "Like" | "Dislike"; activity_id: string }[];
  followers: { local_identifier: string; actor_uri: string; inbox: string; shared_inbox: string | null }[];
  following: { local_identifier: string; remote_uri: string; follow_id: string; accepted: boolean }[];
  inbox: InboxEntry[];
  moderators: { community_identifier: string; actor_uri: string }[];
  bans: { community_uri: string; actor_uri: string; by_actor: string; reason: string | null }[];
  reports: { activity_id: string; reporter_uri: string; object_uri: string; community_uri: string | null; reason: string | null }[];
  outbox: { held: boolean; counts: Record<string, number>; recent: OutboxEntry[] };
}

/** Inbox log rows after `since` (an inbox_log id). */
export async function inboxAfter(since: number): Promise<InboxEntry[]> {
  return (await http<FedditState>("GET", `${FEDDIT}/spike/state`, { query: { since } })).inbox;
}

export async function lastInboxId(): Promise<number> {
  return Math.max(0, ...(await feddit.state()).inbox.map((entry) => Number(entry.id)));
}

export const feddit = {
  state: () => http<FedditState>("GET", `${FEDDIT}/spike/state`),
  call: <T = { uri?: string; activity?: string; json?: unknown }>(path: string, body: unknown) =>
    http<T>("POST", `${FEDDIT}/spike/${path}`, { body }),
};

// ------------------------------------------------------------------ peers

export interface PeerPost {
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
}

/** Moderator and reporting calls (slice 2 probes). */
export interface PeerModeration {
  resolvePerson(token: string, actorUri: string): Promise<number>;
  removePost(token: string, postId: number, removed: boolean, reason: string): Promise<void>;
  lockPost(token: string, postId: number, locked: boolean): Promise<void>;
  featurePost(token: string, postId: number, featured: boolean): Promise<void>;
  ban(token: string, communityId: number, personId: number, ban: boolean, reason: string): Promise<void>;
  reportPost(token: string, postId: number, reason: string): Promise<void>;
  /** Actor ids the peer lists as moderators of one of its communities (local or remote). */
  moderators(token: string, communityId: number): Promise<string[]>;
}

async function communityModerators(origin: string, apiBase: string, token: string, communityId: number): Promise<string[]> {
  const { moderators } = await http<{ moderators?: { moderator: { actor_id: string } }[] }>(
    "GET", `${origin}${apiBase}/community`, { token, query: { id: communityId } });
  return (moderators ?? []).map((entry) => entry.moderator.actor_id);
}

export interface PeerComment {
  id: number;
  apId: string;
  content: string;
  path: string;
  creatorApId: string;
  deleted: boolean;
  removed: boolean;
}

export interface Peer {
  readonly name: "lemmy" | "piefed";
  readonly origin: string;
  readonly user: string;
  readonly admin: string;
  login(username: string): Promise<string>;
  resolveCommunity(token: string, handle: string): Promise<{ id: number; subscribed: string }>;
  follow(token: string, communityId: number): Promise<string>;
  createCommunity(token: string, name: string, title: string): Promise<number>;
  listPosts(token: string, communityId: number): Promise<PeerPost[]>;
  getPost(token: string, postId: number): Promise<PeerPost>;
  resolvePost(token: string, apId: string): Promise<PeerPost | null>;
  createPost(token: string, communityId: number, title: string, body: string): Promise<PeerPost>;
  editPost(token: string, postId: number, title: string, body: string): Promise<void>;
  deletePost(token: string, postId: number): Promise<void>;
  listComments(token: string, postId: number): Promise<PeerComment[]>;
  comment(token: string, postId: number, parentId: number | null, content: string): Promise<PeerComment>;
  editComment(token: string, commentId: number, content: string): Promise<void>;
  deleteComment(token: string, commentId: number): Promise<void>;
  votePost(token: string, postId: number, score: -1 | 0 | 1): Promise<void>;
  voteComment(token: string, commentId: number, score: -1 | 0 | 1): Promise<void>;
  readonly mod: PeerModeration;
}

// Lemmy 0.19 /api/v3 and PieFed /api/alpha share most response shapes
// (PieFed's API mirrors Lemmy's), so one mapper serves both.
interface PostViewWire {
  post: {
    id: number;
    ap_id: string;
    name?: string;
    title?: string;
    body?: string | null;
    url?: string | null;
    deleted: boolean;
    removed?: boolean;
    locked?: boolean;
    featured_community?: boolean;
    sticky?: boolean;
  };
  creator: { actor_id: string };
  counts: { score: number };
}
interface CommentViewWire {
  comment: { id: number; ap_id: string; content?: string; body?: string; path: string; deleted: boolean; removed: boolean };
  creator: { actor_id: string };
}

const toPost = (view: PostViewWire): PeerPost => ({
  id: view.post.id,
  apId: view.post.ap_id,
  title: view.post.name ?? view.post.title ?? "",
  body: view.post.body ?? null,
  url: view.post.url ?? null,
  creatorApId: view.creator.actor_id,
  score: view.counts.score,
  deleted: view.post.deleted,
  removed: view.post.removed ?? false,
  locked: view.post.locked ?? false,
  featured: view.post.featured_community ?? view.post.sticky ?? false,
});

async function resolvePersonId(origin: string, apiBase: string, token: string, actorUri: string): Promise<number> {
  const { person } = await http<{ person?: { person: { id: number } } }>("GET", `${origin}${apiBase}/resolve_object`, {
    token, query: { q: actorUri } });
  if (!person) throw new Error(`could not resolve ${actorUri}`);
  return person.person.id;
}

const toComment = (view: CommentViewWire): PeerComment => ({
  id: view.comment.id,
  apId: view.comment.ap_id,
  content: view.comment.content ?? view.comment.body ?? "",
  path: view.comment.path,
  creatorApId: view.creator.actor_id,
  deleted: view.comment.deleted,
  removed: view.comment.removed,
});

export const lemmy: Peer = {
  name: "lemmy",
  origin: LEMMY,
  user: "lemmyuser",
  admin: "lemmyadmin",
  async login(username) {
    const { jwt } = await http<{ jwt: string }>("POST", `${LEMMY}/api/v3/user/login`, {
      body: { username_or_email: username, password: PASSWORD },
    });
    return jwt;
  },
  async resolveCommunity(token, handle) {
    const { community } = await http<{ community?: { community: { id: number }; subscribed: string } }>(
      "GET", `${LEMMY}/api/v3/resolve_object`, { token, query: { q: handle } });
    if (!community) throw new Error(`lemmy could not resolve ${handle}`);
    return { id: community.community.id, subscribed: community.subscribed };
  },
  async follow(token, communityId) {
    const { community_view } = await http<{ community_view: { subscribed: string } }>(
      "POST", `${LEMMY}/api/v3/community/follow`, { token, body: { community_id: communityId, follow: true } });
    return community_view.subscribed;
  },
  async createCommunity(token, name, title) {
    const { community_view } = await http<{ community_view: { community: { id: number } } }>(
      "POST", `${LEMMY}/api/v3/community`, { token, body: { name, title } });
    return community_view.community.id;
  },
  async listPosts(token, communityId) {
    const { posts } = await http<{ posts: PostViewWire[] }>("GET", `${LEMMY}/api/v3/post/list`, {
      token, query: { community_id: communityId, sort: "New", limit: 50 } });
    return posts.map(toPost);
  },
  async getPost(token, postId) {
    const { post_view } = await http<{ post_view: PostViewWire }>("GET", `${LEMMY}/api/v3/post`, {
      token, query: { id: postId } });
    return toPost(post_view);
  },
  async resolvePost(token, apId) {
    const { post } = await http<{ post?: PostViewWire }>("GET", `${LEMMY}/api/v3/resolve_object`, {
      token, query: { q: apId } });
    return post ? toPost(post) : null;
  },
  async createPost(token, communityId, title, body) {
    const { post_view } = await http<{ post_view: PostViewWire }>("POST", `${LEMMY}/api/v3/post`, {
      token, body: { name: title, body, community_id: communityId } });
    return toPost(post_view);
  },
  async editPost(token, postId, title, body) {
    await http("PUT", `${LEMMY}/api/v3/post`, { token, body: { post_id: postId, name: title, body } });
  },
  async deletePost(token, postId) {
    await http("POST", `${LEMMY}/api/v3/post/delete`, { token, body: { post_id: postId, deleted: true } });
  },
  async listComments(token, postId) {
    const { comments } = await http<{ comments: CommentViewWire[] }>("GET", `${LEMMY}/api/v3/comment/list`, {
      token, query: { post_id: postId, sort: "New", type_: "All", limit: 50 } });
    return comments.map(toComment);
  },
  async comment(token, postId, parentId, content) {
    const { comment_view } = await http<{ comment_view: CommentViewWire }>("POST", `${LEMMY}/api/v3/comment`, {
      token, body: { content, post_id: postId, ...(parentId ? { parent_id: parentId } : {}) } });
    return toComment(comment_view);
  },
  async editComment(token, commentId, content) {
    await http("PUT", `${LEMMY}/api/v3/comment`, { token, body: { comment_id: commentId, content } });
  },
  async deleteComment(token, commentId) {
    await http("POST", `${LEMMY}/api/v3/comment/delete`, { token, body: { comment_id: commentId, deleted: true } });
  },
  async votePost(token, postId, score) {
    await http("POST", `${LEMMY}/api/v3/post/like`, { token, body: { post_id: postId, score } });
  },
  async voteComment(token, commentId, score) {
    await http("POST", `${LEMMY}/api/v3/comment/like`, { token, body: { comment_id: commentId, score } });
  },
  mod: {
    resolvePerson: (token, actorUri) => resolvePersonId(LEMMY, "/api/v3", token, actorUri),
    async removePost(token, postId, removed, reason) {
      await http("POST", `${LEMMY}/api/v3/post/remove`, { token, body: { post_id: postId, removed, reason } });
    },
    async lockPost(token, postId, locked) {
      await http("POST", `${LEMMY}/api/v3/post/lock`, { token, body: { post_id: postId, locked } });
    },
    async featurePost(token, postId, featured) {
      await http("POST", `${LEMMY}/api/v3/post/feature`, { token, body: { post_id: postId, featured, feature_type: "Community" } });
    },
    async ban(token, communityId, personId, ban, reason) {
      await http("POST", `${LEMMY}/api/v3/community/ban_user`, {
        token, body: { community_id: communityId, person_id: personId, ban, reason, remove_data: false } });
    },
    async reportPost(token, postId, reason) {
      await http("POST", `${LEMMY}/api/v3/post/report`, { token, body: { post_id: postId, reason } });
    },
    moderators: (token, communityId) => communityModerators(LEMMY, "/api/v3", token, communityId),
  },
};

export const piefed: Peer = {
  name: "piefed",
  origin: PIEFED,
  user: "pfuser",
  admin: "pfadmin",
  async login(username) {
    const { jwt } = await http<{ jwt: string }>("POST", `${PIEFED}/api/alpha/user/login`, {
      body: { username, password: PASSWORD },
    });
    return jwt;
  },
  async resolveCommunity(token, handle) {
    const { community } = await http<{ community?: { community: { id: number }; subscribed: string } }>(
      "GET", `${PIEFED}/api/alpha/resolve_object`, { token, query: { q: handle } });
    if (!community) throw new Error(`piefed could not resolve ${handle}`);
    return { id: community.community.id, subscribed: community.subscribed };
  },
  async follow(token, communityId) {
    const { community_view } = await http<{ community_view: { subscribed: string } }>(
      "POST", `${PIEFED}/api/alpha/community/follow`, { token, body: { community_id: communityId, follow: true } });
    return community_view.subscribed;
  },
  async createCommunity(token, name, title) {
    const { community_view } = await http<{ community_view: { community: { id: number } } }>(
      "POST", `${PIEFED}/api/alpha/community`, { token, body: { name, title } });
    return community_view.community.id;
  },
  async listPosts(token, communityId) {
    const { posts } = await http<{ posts: PostViewWire[] }>("GET", `${PIEFED}/api/alpha/post/list`, {
      token, query: { community_id: communityId, sort: "New", limit: 50 } });
    return posts.map(toPost);
  },
  async getPost(token, postId) {
    const { post_view } = await http<{ post_view: PostViewWire }>("GET", `${PIEFED}/api/alpha/post`, {
      token, query: { id: postId } });
    return toPost(post_view);
  },
  async resolvePost(token, apId) {
    const { post } = await http<{ post?: PostViewWire }>("GET", `${PIEFED}/api/alpha/resolve_object`, {
      token, query: { q: apId } });
    return post ? toPost(post) : null;
  },
  async createPost(token, communityId, title, body) {
    const { post_view } = await http<{ post_view: PostViewWire }>("POST", `${PIEFED}/api/alpha/post`, {
      token, body: { title, body, community_id: communityId } });
    return toPost(post_view);
  },
  async editPost(token, postId, title, body) {
    await http("PUT", `${PIEFED}/api/alpha/post`, { token, body: { post_id: postId, title, body } });
  },
  async deletePost(token, postId) {
    await http("POST", `${PIEFED}/api/alpha/post/delete`, { token, body: { post_id: postId, deleted: true } });
  },
  async listComments(token, postId) {
    const { comments } = await http<{ comments: CommentViewWire[] }>("GET", `${PIEFED}/api/alpha/comment/list`, {
      token, query: { post_id: postId, sort: "New", limit: 50 } });
    return comments.map(toComment);
  },
  async comment(token, postId, parentId, content) {
    const { comment_view } = await http<{ comment_view: CommentViewWire }>("POST", `${PIEFED}/api/alpha/comment`, {
      token, body: { body: content, post_id: postId, ...(parentId ? { parent_id: parentId } : {}) } });
    return toComment(comment_view);
  },
  async editComment(token, commentId, content) {
    await http("PUT", `${PIEFED}/api/alpha/comment`, { token, body: { comment_id: commentId, body: content } });
  },
  async deleteComment(token, commentId) {
    await http("POST", `${PIEFED}/api/alpha/comment/delete`, { token, body: { comment_id: commentId, deleted: true } });
  },
  async votePost(token, postId, score) {
    await http("POST", `${PIEFED}/api/alpha/post/like`, { token, body: { post_id: postId, score } });
  },
  async voteComment(token, commentId, score) {
    await http("POST", `${PIEFED}/api/alpha/comment/like`, { token, body: { comment_id: commentId, score } });
  },
  mod: {
    resolvePerson: (token, actorUri) => resolvePersonId(PIEFED, "/api/alpha", token, actorUri),
    async removePost(token, postId, removed, reason) {
      await http("POST", `${PIEFED}/api/alpha/post/remove`, { token, body: { post_id: postId, removed, reason } });
    },
    async lockPost(token, postId, locked) {
      await http("POST", `${PIEFED}/api/alpha/post/lock`, { token, body: { post_id: postId, locked } });
    },
    async featurePost(token, postId, featured) {
      await http("POST", `${PIEFED}/api/alpha/post/feature`, { token, body: { post_id: postId, featured, feature_type: "Community" } });
    },
    async ban(token, communityId, personId, ban, reason) {
      if (ban) {
        await http("POST", `${PIEFED}/api/alpha/community/moderate/ban`, {
          token, body: { community_id: communityId, user_id: personId, reason, permanent: true } });
      } else {
        await http("PUT", `${PIEFED}/api/alpha/community/moderate/unban`, {
          token, body: { community_id: communityId, user_id: personId } });
      }
    },
    async reportPost(token, postId, reason) {
      await http("POST", `${PIEFED}/api/alpha/post/report`, { token, body: { post_id: postId, reason } });
    },
    moderators: (token, communityId) => communityModerators(PIEFED, "/api/alpha", token, communityId),
  },
};

export const PEERS = { lemmy, piefed } as const;
