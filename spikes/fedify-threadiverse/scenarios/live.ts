// Slice 3 live runner: the public lab (LIVE_LAB_ORIGIN) against a real PieFed
// instance. Runs from a laptop, not inside Docker. See LIVE.md.
//
// Posts only into communities we control: the lab's own `lab`, and one
// existing local community on the PieFed instance. L10 only follows
// communities elsewhere; it never posts, comments or votes in them.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type FedditState,
  HttpError,
  type InboxEntry,
  makeFeddit,
  makePiefed,
  NotApplicable,
  recorder,
  runId,
  sleep,
  waitFor,
} from "./lib.ts";

const USAGE = `Usage: node scenarios/live.ts [--only=L1,L3] [--run=<id>] [--keep] [--cleanup]

Drives the public peblish federation lab and a real PieFed instance through
scenarios L1 to L10 (LIVE.md). All test content is titled
"[peblish lab test <run>] ...".

Flags
  --only=L1,L3   run only these scenarios (L9 only when listed)
  --run=<id>     reuse a previous run's names and ids (captures/live-<id>-ids.json)
  --keep         skip the automatic cleanup (L9) after a full run
  --cleanup      run only L9 for --run=<id>: delete what the run created, unfollow
  --help         print this text

Environment (required unless noted)
  LIVE_LAB_ORIGIN          the lab, e.g. https://lab.feddit.com
  LIVE_CONTROL_TOKEN       the lab's FEDDIT_CONTROL_TOKEN
  LIVE_PIEFED_ORIGIN       the PieFed instance, e.g. https://feddit.com
  LIVE_PIEFED_USER         its non-admin test account
  LIVE_PIEFED_PASSWORD
  LIVE_PIEFED_COMMUNITY    an existing local community there (never created)
  LIVE_TIMEOUT_MS          optional, per wait, default 180000
  LIVE_FOLLOW_ONLY         optional, comma-separated !name@host communities on
                           other instances for L10 (follow and observe only)
  LIVE_FOLLOW_OBSERVE_MS   optional, L10 observation window, default 120000
`;

const args = process.argv.slice(2);
const die = (message: string): never => {
  console.error(message);
  return process.exit(2);
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// ---------------------------------------------------------------- flags and environment

const SCENARIO_IDS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];
const flagValue = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const unknownArgs = args.filter((a) => a !== "--keep" && a !== "--cleanup" && !/^--(only|run)=/.test(a));
if (unknownArgs.length > 0) die(`Unknown argument: ${unknownArgs.join(" ")}\n\n${USAGE}`);

const keep = args.includes("--keep");
const cleanupOnly = args.includes("--cleanup");
if (keep && cleanupOnly) die("--keep and --cleanup contradict each other");
const onlyFlag = flagValue("only")?.split(",");
const badOnly = onlyFlag?.filter((id) => !SCENARIO_IDS.includes(id));
if (badOnly?.length) die(`Unknown scenario in --only: ${badOnly.join(", ")} (known: ${SCENARIO_IDS.join(", ")})`);
const only = cleanupOnly ? ["L9"] : onlyFlag;

const env = (name: string) => process.env[name] ?? "";
const REQUIRED = [
  "LIVE_LAB_ORIGIN",
  "LIVE_CONTROL_TOKEN",
  "LIVE_PIEFED_ORIGIN",
  "LIVE_PIEFED_USER",
  "LIVE_PIEFED_PASSWORD",
  "LIVE_PIEFED_COMMUNITY",
];
const missing = REQUIRED.filter((name) => !env(name));
if (missing.length > 0) {
  die(`Missing environment variables: ${missing.join(", ")}\nRun with --help for the full list.`);
}
const originOf = (name: string) =>
  URL.canParse(env(name)) ? new URL(env(name)).origin : die(`${name} must be a URL such as https://example.com`);
const numberOf = (name: string, fallback: number) => {
  if (!env(name)) return fallback;
  const value = Number(env(name));
  return Number.isFinite(value) && value >= 0 ? value : die(`${name} must be a number of milliseconds`);
};

const LAB = originOf("LIVE_LAB_ORIGIN");
const LAB_HOST = new URL(LAB).host;
const PIEFED_ORIGIN = originOf("LIVE_PIEFED_ORIGIN");
const PIEFED_HOST = new URL(PIEFED_ORIGIN).host;
const PIEFED_USER = env("LIVE_PIEFED_USER");
const COMMUNITY = env("LIVE_PIEFED_COMMUNITY").replace(/^!/, "").replace(/@.*$/, "");
const TIMEOUT_MS = numberOf("LIVE_TIMEOUT_MS", 180_000) || 180_000;
const OBSERVE_MS = numberOf("LIVE_FOLLOW_OBSERVE_MS", 120_000);
const FOLLOW_ONLY = env("LIVE_FOLLOW_ONLY").split(",").map((handle) => handle.trim()).filter(Boolean);
for (const handle of FOLLOW_ONLY) {
  if (!/^![\w.-]+@[\w.-]+(:\d+)?$/.test(handle)) die(`LIVE_FOLLOW_ONLY: "${handle}" is not of the form !name@host`);
}

const CAPTURES = new URL("../captures/", import.meta.url);
mkdirSync(CAPTURES, { recursive: true });
const runFlag = flagValue("run");
if (cleanupOnly && !runFlag) {
  const known = readdirSync(CAPTURES)
    .flatMap((file) => /^live-(.+)-ids\.json$/.exec(file)?.[1] ?? [])
    .sort()
    .slice(-5);
  die(`--cleanup needs --run=<id>${known.length ? ` (recent runs: ${known.join(", ")})` : ""}`);
}
const RUN = runFlag ?? runId();
if (!/^[A-Za-z0-9]+$/.test(RUN)) die("--run must be letters and digits only");

// ---------------------------------------------------------------- names

const MODERATOR = "labmod";
const LAB_COMMUNITY = "lab";
const AUTHOR = `t${RUN}`;
const labActor = (identifier: string) => `${LAB}/ap/${identifier}`;
const AUTHOR_URI = labActor(`u.${AUTHOR}`);
const LAB_URI = labActor(`c.${LAB_COMMUNITY}`);
const LAB_HANDLE = `!${LAB_COMMUNITY}@${LAB_HOST}`;
const COMMUNITY_HANDLE = `!${COMMUNITY}@${PIEFED_HOST}`;
const PIEFED_ACTOR = `${PIEFED_ORIGIN}/u/${PIEFED_USER}`;
/** Starts every title, and every comment, this run creates; cleanup deletes nothing without it. */
const PREFIX = `[peblish lab test ${RUN}]`;
const title = (what: string) => `${PREFIX} ${what}`;

// ---------------------------------------------------------------- the ids file

/** A follow by the lab author: the community's actor URI and our Follow's id. */
interface Follow {
  actor: string;
  followId: string;
}

/**
 * Everything a run creates, so `--cleanup --run=<id>` can find it later.
 * `uri` fields are ActivityPub ids; `*Id` fields are PieFed's numeric ids.
 */
interface Ids {
  run: string;
  /** The deployment these ids belong to; a run is refused against any other. */
  env: { lab: string; piefedOrigin: string; piefedUser: string; community: string };
  actors: {
    author: string;
    authorUri: string;
    moderator: string;
    moderatorUri: string;
    community: string;
    communityUri: string;
  };
  /** L1: the lab community as PieFed knows it. */
  labCommunityId?: number;
  /** L3: the lab's posts and their PieFed ids. */
  textPostUri?: string;
  textPostId?: number;
  linkPostUri?: string;
  linkPostId?: number;
  /** L4: the test account's post in the lab community, and its comment on the L3 text post. */
  piefedPostUri?: string;
  piefedPostId?: number;
  piefedCommentUri?: string;
  piefedCommentId?: number;
  /** L8: the PieFed community, the lab author's post in it, and the test account's comment on that. */
  remoteCommunityId?: number;
  remotePostUri?: string;
  remotePostId?: number;
  remoteCommentUri?: string;
  remoteCommentId?: number;
  /** L8 and L10: communities the lab author follows, by handle. */
  follows: Record<string, Follow>;
  /** Posts the lab author has made. PieFed caps a remote account's first posts, so a run stops at MAX_POSTS_PER_AUTHOR. */
  postsCreated: number;
  /** L7 sets these before it locks the L3 text post and removes the L4 comment, and clears them once undone; L9 reverses what is left. */
  textPostLocked?: boolean;
  commentRemoved?: boolean;
}

const idsFile = new URL(`live-${RUN}-ids.json`, CAPTURES);
if (cleanupOnly && !existsSync(idsFile)) die(`No ids file for run ${RUN} (${idsFile.pathname})`);
const loaded: Partial<Ids> = existsSync(idsFile) ? JSON.parse(readFileSync(idsFile, "utf8")) : {};
const ENV_BINDING = { lab: LAB, piefedOrigin: PIEFED_ORIGIN, piefedUser: PIEFED_USER, community: COMMUNITY };
if (existsSync(idsFile)) {
  if (!loaded.env) die(`${idsFile.pathname} has no env block, so it cannot be tied to this deployment. Add one by hand if you are sure.`);
  const differing = (["lab", "piefedOrigin", "piefedUser", "community"] as const).filter(
    (key) => loaded.env?.[key] !== ENV_BINDING[key],
  );
  if (differing.length > 0) {
    die(`Run ${RUN} was recorded for a different deployment (${differing.join(", ")} differ from the current environment). Refusing to reuse or clean it up.`);
  }
}
const ids: Ids = {
  follows: {},
  postsCreated: 0,
  ...loaded,
  run: RUN,
  env: ENV_BINDING,
  actors: {
    author: AUTHOR,
    authorUri: AUTHOR_URI,
    moderator: MODERATOR,
    moderatorUri: labActor(`u.${MODERATOR}`),
    community: LAB_COMMUNITY,
    communityUri: LAB_URI,
  },
};
const save = () => writeFileSync(idsFile, `${JSON.stringify(ids, null, 2)}\n`);
/** Stores what a scenario just created, before it waits on anything. */
const remember = (patch: Partial<Ids>) => {
  Object.assign(ids, patch);
  save();
};

// ---------------------------------------------------------------- clients

const lab = makeFeddit(LAB, env("LIVE_CONTROL_TOKEN"));
const piefed = makePiefed({ origin: PIEFED_ORIGIN, user: PIEFED_USER, password: env("LIVE_PIEFED_PASSWORD") });
const PEER = piefed.name;

const state = () => lab.state();
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const wait = <T>(label: string, probe: () => Promise<T | null | undefined | false>) =>
  waitFor(label, probe, { timeoutMs: TIMEOUT_MS, intervalMs: 3_000 });
const labObject = (s: FedditState, uri: string) => s.objects.find((o) => o.uri === uri);

function needed<T>(value: T | undefined, from: string): T {
  if (value === undefined) throw new Error(`needs ${from} (run it first, or pass --run=<id> of a run that did)`);
  return value;
}

let token: string;
try {
  console.log(`run ${RUN}: lab ${LAB}, PieFed ${PIEFED_ORIGIN} as ${PIEFED_USER}`);
  await state();
} catch (error) {
  die(error instanceof HttpError && error.status === 401
    ? "The lab rejected LIVE_CONTROL_TOKEN (401)."
    : `Cannot read ${LAB}/spike/state: ${errorMessage(error)}`);
}
try {
  token = await piefed.login(PIEFED_USER);
} catch (error) {
  token = die(`PieFed login as ${PIEFED_USER} failed: ${errorMessage(error)}`);
}
save();

// ---------------------------------------------------------------- lab fixtures

/** Idempotent: moderator user, the community (moderated by it) and this run's author. */
async function ensureFixtures(): Promise<void> {
  const s = await state();
  const has = (identifier: string) => s.actors.some((a) => a.identifier === identifier);
  const created: string[] = [];
  const person = async (name: string, displayName: string) => {
    if (has(`u.${name}`)) return;
    await lab.call("actors", { kind: "Person", name, displayName });
    created.push(name);
  };
  await person(MODERATOR, "peblish lab moderator");
  const moderated = s.moderators.some(
    (m) => m.community_identifier === `c.${LAB_COMMUNITY}` && m.actor_uri === ids.actors.moderatorUri,
  );
  if (!has(`c.${LAB_COMMUNITY}`) || !moderated) {
    await lab.call("actors", {
      kind: "Group",
      name: LAB_COMMUNITY,
      displayName: "peblish federation lab",
      summary: "Test community of the **peblish** federation lab.",
      moderators: [MODERATOR],
    });
    created.push(`!${LAB_COMMUNITY}`);
  }
  await person(AUTHOR, `peblish lab tester ${RUN}`);
  console.log(created.length ? `lab fixtures created: ${created.join(", ")}` : "lab fixtures already in place");
}

// ---------------------------------------------------------------- helpers

/**
 * Waits until the lab's outbox has delivered `activity` (or an Announce
 * wrapping it) to PieFed, and fails at once if PieFed refused it. This is the
 * lab-side half of every scenario that sends something to PieFed.
 */
async function delivered(activity: string): Promise<string> {
  const row = await wait(`the lab delivering ${activity} to PieFed`, async () => {
    const found = (await state()).outbox.recent.find(
      (r) => (r.activity_id === activity || r.object_id === activity) && r.inbox.startsWith(`${PIEFED_ORIGIN}/`),
    );
    return found && found.status !== "pending" && found;
  });
  if (row.status === "failed") throw new Error(`PieFed refused ${row.activity_type}: ${row.last_status} ${row.last_error}`);
  return `${row.activity_type} answered ${row.last_status}`;
}

/** True once PieFed no longer serves the post, or serves it as deleted or removed. */
async function postGone(postId: number): Promise<boolean> {
  try {
    const post = await piefed.getPost(token, postId);
    return post.deleted || post.removed;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || /couldnt_find|not.?found|deleted/i.test(error.body))) {
      return true;
    }
    throw error;
  }
}

const findComment = async (postId: number, uri: string) =>
  (await piefed.listComments(token, postId)).find((c) => c.apId === uri);

/** The lab author follows `handle` and waits for the Accept; a Follow this run already had accepted is not repeated. */
async function followRemote(handle: string): Promise<Follow> {
  const accepted = (s: FedditState, follow: Follow) =>
    s.following.some((f) =>
      f.local_identifier === `u.${AUTHOR}` && f.remote_uri === follow.actor && f.follow_id === follow.followId && f.accepted);
  const prior = ids.follows[handle];
  if (prior && accepted(await state(), prior)) return prior;
  const sent = await lab.call<{ remote: string; activity: string }>("follow", { follower: AUTHOR, target: handle });
  const follow = { actor: sent.remote, followId: sent.activity };
  remember({ follows: { ...ids.follows, [handle]: follow } });
  await wait(`${handle} to accept the Follow`, async () => accepted(await state(), follow));
  return follow;
}

/**
 * inbox_log rows (written by record() in src/inbox.ts) whose actor lives on
 * `host`. `actor` is the activity's actor: for an Announce, the community.
 */
const inboxFromHost = (inbox: InboxEntry[], host: string) =>
  inbox.filter((entry) => entry.actor && URL.canParse(entry.actor) && new URL(entry.actor).host === host);

const maxId = (rows: { id: string }[]) => Math.max(0, ...rows.map((row) => Number(row.id)));

/** True when the lab holds the object and has not marked it deleted. */
const liveOnLab = (s: FedditState, uri: string) => {
  const object = labObject(s, uri);
  return object !== undefined && !object.deleted;
};

const labModerate = (action: string, object: string, extra: Record<string, string> = {}) =>
  lab.call<{ activity: string }>("moderate", { moderator: MODERATOR, action, object, community: LAB_COMMUNITY, ...extra });

// ---- creating content: saved at once, reused on a rerun, and capped

/**
 * PieFed lets a remote account it first saw within 24 hours make 4 posts. A run
 * makes 3 per lab author (two in L3, one in L8), so a rerun with --run stays
 * under the cap or stops.
 */
const MAX_POSTS_PER_AUTHOR = 3;

type PostKey = "textPostUri" | "linkPostUri" | "remotePostUri";

/**
 * A post by the lab author. A rerun reuses the one the ids already hold while
 * the lab still has it; a new one is refused past MAX_POSTS_PER_AUTHOR, counted
 * from the ids and from what the lab holds. The URI is saved before anything else happens.
 */
async function labPost(
  key: PostKey,
  post: { community: string; title: string; body: string; link?: string },
): Promise<{ uri: string; activity?: string }> {
  const s = await state();
  const existing = ids[key];
  if (existing && liveOnLab(s, existing)) return { uri: existing };
  const held = s.objects.filter((o) => o.local && o.kind === "Page" && o.author_uri === AUTHOR_URI).length;
  const made = Math.max(ids.postsCreated, held);
  if (made >= MAX_POSTS_PER_AUTHOR) {
    throw new Error(`refusing to create post number ${made + 1} for ${AUTHOR}: PieFed caps a new remote account's posts`);
  }
  const created = await lab.call<{ uri: string; activity: string }>("post", { author: AUTHOR, ...post });
  ids[key] = created.uri;
  remember({ postsCreated: ids.postsCreated + 1 });
  return created;
}

/** What an earlier attempt created on PieFed, if the lab or PieFed still has it. */
async function existingPiefedPost(uri?: string, id?: number) {
  if (uri === undefined || id === undefined) return undefined;
  return liveOnLab(await state(), uri) || !(await postGone(id)) ? { apId: uri, id } : undefined;
}

async function existingPiefedComment(postId: number, uri?: string, id?: number) {
  if (uri === undefined || id === undefined) return undefined;
  const onPiefed = await findComment(postId, uri);
  return liveOnLab(await state(), uri) || (onPiefed && !onPiefed.deleted && !onPiefed.removed) ? { apId: uri, id } : undefined;
}

// ---- deleting content: only what this run made

const OURS = new Set([PIEFED_ACTOR, AUTHOR_URI]);

/** Throws unless PieFed's copy of the post is the test account's or the lab author's and carries this run's prefix. */
async function assertOurPost(postId: number, uri: string): Promise<void> {
  const post = await piefed.getPost(token, postId);
  if (post.apId !== uri || !OURS.has(post.creatorApId) || !post.title.startsWith(PREFIX)) {
    throw new Error(`refusing to touch PieFed post ${postId}: it is not this run's (${post.creatorApId}, "${post.title.slice(0, 60)}")`);
  }
}

async function assertOurComment(postId: number, commentId: number, uri: string): Promise<void> {
  const comment = (await piefed.listComments(token, postId)).find((c) => c.id === commentId);
  if (!comment || comment.apId !== uri || !OURS.has(comment.creatorApId) || !comment.content.includes(PREFIX)) {
    throw new Error(`refusing to touch PieFed comment ${commentId} on post ${postId}: not found or not this run's`);
  }
}

/** Throws unless the object is local, by the lab author, and carries this run's prefix. */
function assertOurLabPost(object: FedditState["objects"][number]): void {
  if (!object.local || object.author_uri !== AUTHOR_URI || !object.title?.startsWith(PREFIX)) {
    throw new Error(`refusing to delete ${object.uri} on the lab: it is not this run's`);
  }
}

// ---------------------------------------------------------------- scenarios

if (!cleanupOnly) await ensureFixtures();
const { scenario, finish, results } = recorder(only);

// L1: PieFed finds the lab community through WebFinger and the actor document.
await scenario("L1", PEER, async () => {
  const resolved = await wait(`PieFed to resolve ${LAB_HANDLE}`, () => piefed.resolveCommunity(token, LAB_HANDLE));
  remember({ labCommunityId: resolved.id });
  return `${LAB_HANDLE} is community ${resolved.id} on PieFed (subscribed: ${resolved.subscribed})`;
});

// L2: the test account follows the lab community; the lab stores it and its Accept reaches PieFed.
await scenario("L2", PEER, async () => {
  const communityId = needed(ids.labCommunityId, "L1");
  const follows = async () =>
    (await state()).followers.some((f) => f.local_identifier === `c.${LAB_COMMUNITY}` && f.actor_uri === PIEFED_ACTOR);
  const known = await follows();
  const baseline = maxId((await state()).outbox.recent);
  if (!known) {
    // PieFed answers "Subscribed" at once and sends no Follow again for a member it already has.
    if ((await piefed.resolveCommunity(token, LAB_HANDLE)).subscribed === "Subscribed") {
      await piefed.unfollow(token, communityId);
      await sleep(3_000);
    }
    await piefed.follow(token, communityId);
  }
  await wait("PieFed to show Subscribed", async () =>
    (await piefed.resolveCommunity(token, LAB_HANDLE)).subscribed === "Subscribed");
  await wait("the lab to store PieFed's follower", follows);
  if (known) return "already following; the lab has the follower";
  const accept = await wait("the lab's Accept to reach PieFed", async () =>
    (await state()).outbox.recent.find((r) =>
      Number(r.id) > baseline && r.activity_type === "Accept" && r.inbox.startsWith(`${PIEFED_ORIGIN}/`) && r.status === "delivered"));
  return `${PIEFED_ACTOR} follows ${LAB_HANDLE}; Accept answered ${accept.last_status}`;
});

// L3: lab posts (text, link) reach PieFed.
await scenario("L3", PEER, async () => {
  const communityId = needed(ids.labCommunityId, "L1");
  const link = `${LAB}/link-target?run=${RUN}`;
  const text = await labPost("textPostUri", {
    community: LAB_COMMUNITY,
    title: title("text post"),
    body: "Hello from **peblish**. This is a text post.",
  });
  const linked = await labPost("linkPostUri", { community: LAB_COMMUNITY, title: title("link post"), body: "A link post.", link });
  const seenOnPieFed = (uri: string) => async () => (await piefed.listPosts(token, communityId)).find((p) => p.apId === uri);
  const [seenText, seenLink] = await Promise.all([
    wait("the text post in PieFed's community", seenOnPieFed(text.uri)),
    wait("the link post in PieFed's community", seenOnPieFed(linked.uri)),
  ]);
  remember({ textPostId: seenText.id, linkPostId: seenLink.id });
  if (seenText.title !== title("text post")) throw new Error(`title ${JSON.stringify(seenText.title)}`);
  if (!seenText.body?.includes("Hello from **peblish**")) throw new Error(`body ${JSON.stringify(seenText.body)}`);
  if (seenText.creatorApId !== AUTHOR_URI) throw new Error(`creator ${seenText.creatorApId}`);
  if (seenLink.url !== link) throw new Error(`link url ${JSON.stringify(seenLink.url)}`);
  const delivery = text.activity ? await delivered(text.activity) : "posts were already there";
  return `text post ${seenText.id} and link post ${seenLink.id} shown with title, markdown body, author and url; ${delivery}`;
});

// L4: the test account's post and comment reach the lab, once.
await scenario("L4", PEER, async () => {
  const communityId = needed(ids.labCommunityId, "L1");
  const textPostId = needed(ids.textPostId, "L3");
  const textPostUri = needed(ids.textPostUri, "L3");
  let post = await existingPiefedPost(ids.piefedPostUri, ids.piefedPostId);
  if (!post) {
    post = await piefed.createPost(token, communityId, title("post from PieFed"), "Posted from **PieFed** into the lab community.");
    remember({ piefedPostUri: post.apId, piefedPostId: post.id });
  }
  let comment = await existingPiefedComment(textPostId, ids.piefedCommentUri, ids.piefedCommentId);
  if (!comment) {
    comment = await piefed.comment(token, textPostId, null, title("comment from PieFed"));
    remember({ piefedCommentUri: comment.apId, piefedCommentId: comment.id });
  }
  const storedPost = await wait("the lab to store the post", async () => labObject(await state(), post.apId));
  const storedComment = await wait("the lab to store the comment", async () => labObject(await state(), comment.apId));
  if (storedPost.community_uri !== LAB_URI) throw new Error(`post community ${storedPost.community_uri}`);
  if (storedPost.author_uri !== PIEFED_ACTOR) throw new Error(`post author ${storedPost.author_uri}`);
  if (storedComment.in_reply_to !== textPostUri) throw new Error(`comment inReplyTo ${storedComment.in_reply_to}`);
  // The lab's relay skips the sender's origin, so nothing comes back; PieFed must still show each once.
  const comments = (await piefed.listComments(token, textPostId)).filter((c) => c.apId === comment.apId);
  const posts = (await piefed.listPosts(token, communityId)).filter((p) => p.apId === post.apId);
  if (comments.length !== 1 || posts.length !== 1) {
    throw new Error(`PieFed shows the comment ${comments.length}x and the post ${posts.length}x`);
  }
  return `post ${post.id} and comment ${comment.id} stored by the lab (${storedPost.via}, ${storedComment.via}); PieFed shows each once`;
});

// L5: a vote from PieFed arrives, and its undo removes it.
await scenario("L5", PEER, async () => {
  const postId = needed(ids.textPostId, "L3");
  const postUri = needed(ids.textPostUri, "L3");
  const voted = async () =>
    (await state()).votes.some((v) => v.voter_uri === PIEFED_ACTOR && v.object_uri === postUri && v.kind === "Like");
  const before = (await piefed.getPost(token, postId)).score;
  await piefed.votePost(token, postId, 1);
  await wait("the lab to store the Like", voted);
  const up = await wait("PieFed's score to rise", async () => {
    const score = (await piefed.getPost(token, postId)).score;
    return score === before + 1 && score;
  });
  await piefed.votePost(token, postId, 0);
  await wait("the lab to drop the Like", async () => !(await voted()));
  await wait("PieFed's score to settle", async () => (await piefed.getPost(token, postId)).score === before);
  return `Like stored (score ${before} to ${up}), then undone (back to ${before})`;
});

// L6: the lab edits one post and deletes the other.
await scenario("L6", PEER, async () => {
  const textUri = needed(ids.textPostUri, "L3");
  const textId = needed(ids.textPostId, "L3");
  const linkUri = needed(ids.linkPostUri, "L3");
  const linkId = needed(ids.linkPostId, "L3");
  const editedTitle = title("text post (edited)");
  const edit = await lab.call<{ activity: string }>("edit", {
    object: textUri,
    title: editedTitle,
    body: "Edited body from **peblish**.",
  });
  const editDelivery = await delivered(edit.activity);
  const seen = await wait("PieFed to show the edit", async () => {
    const post = await piefed.getPost(token, textId);
    return post.body?.includes("Edited body") && post;
  });
  if (seen.title !== editedTitle) throw new Error(`title not updated: ${seen.title}`);
  const removal = await lab.call<{ activity: string }>("delete", { object: linkUri });
  const removalDelivery = await delivered(removal.activity);
  await wait("PieFed to hide the deleted link post", () => postGone(linkId));
  if (!labObject(await state(), linkUri)?.deleted) throw new Error("the lab does not mark the link post deleted");
  return `Update applied (${editDelivery}); Delete applied (${removalDelivery})`;
});

// L7: the lab moderator locks and unlocks a post, then removes and restores the test account's comment.
await scenario("L7", PEER, async () => {
  const textUri = needed(ids.textPostUri, "L3");
  const textId = needed(ids.textPostId, "L3");
  const commentUri = needed(ids.piefedCommentUri, "L4");
  const locked = async (expected: boolean) => (await piefed.getPost(token, textId)).locked === expected;

  // The flags are set before the action and cleared once it is undone, so L9 can reverse what a failed run left.
  remember({ textPostLocked: true });
  await delivered((await labModerate("lock", textUri)).activity);
  await wait("PieFed to show the lock", () => locked(true));
  if (!labObject(await state(), textUri)?.locked) throw new Error("the lab does not mark the post locked");
  await delivered((await labModerate("unlock", textUri)).activity);
  await wait("PieFed to show the unlock", () => locked(false));
  remember({ textPostLocked: false });

  const reason = title("removed by the lab moderator");
  remember({ commentRemoved: true });
  await delivered((await labModerate("remove", commentUri, { reason })).activity);
  await wait("PieFed to show the comment removed", async () => {
    const comment = await findComment(textId, commentUri);
    return !comment || comment.removed || comment.deleted;
  });
  if (!labObject(await state(), commentUri)?.removed) throw new Error("the lab does not mark the comment removed");
  await delivered((await labModerate("restore", commentUri)).activity);
  await wait("PieFed to show the comment restored", async () => {
    const comment = await findComment(textId, commentUri);
    return comment && !comment.removed && !comment.deleted;
  });
  remember({ commentRemoved: false });
  return "lock and unlock of the post, removal with a reason and restore of the comment, all shown on PieFed";
});

// L8: the lab author follows a PieFed community, posts into it, and hears of a PieFed comment.
await scenario("L8", PEER, async () => {
  const follow = await followRemote(COMMUNITY_HANDLE);
  const community = await piefed.resolveCommunity(token, COMMUNITY_HANDLE);
  remember({ remoteCommunityId: community.id });
  const created = await labPost("remotePostUri", {
    community: COMMUNITY_HANDLE,
    title: title(`post into ${COMMUNITY}`),
    body: "Posted from the **peblish** lab into a community it follows.",
  });
  const seen = await wait(`the lab post in ${COMMUNITY_HANDLE}`, async () =>
    (await piefed.listPosts(token, community.id)).find((p) => p.apId === created.uri));
  remember({ remotePostId: seen.id });
  if (seen.title !== title(`post into ${COMMUNITY}`)) throw new Error(`title ${JSON.stringify(seen.title)}`);
  if (seen.creatorApId !== AUTHOR_URI) throw new Error(`creator ${seen.creatorApId}`);
  const delivery = created.activity ? await delivered(created.activity) : "post was already there";
  let comment = await existingPiefedComment(seen.id, ids.remoteCommentUri, ids.remoteCommentId);
  if (!comment) {
    comment = await piefed.comment(token, seen.id, null, title("comment from PieFed"));
    remember({ remoteCommentUri: comment.apId, remoteCommentId: comment.id });
  }
  const stored = await wait("the lab to receive the comment", async () => labObject(await state(), comment.apId));
  if (stored.in_reply_to !== created.uri) throw new Error(`comment inReplyTo ${stored.in_reply_to}`);
  if (stored.author_uri !== PIEFED_ACTOR) throw new Error(`comment author ${stored.author_uri}`);
  return `followed ${follow.actor}; post ${seen.id} shown (${delivery}); comment ${comment.id} reached the lab via ${stored.via}`;
});

// L10: follow communities on other instances and watch what arrives. Never posts.
if (FOLLOW_ONLY.length === 0) {
  await scenario("L10", "-", async () => {
    throw new NotApplicable("LIVE_FOLLOW_ONLY is not set");
  });
}
for (const handle of FOLLOW_ONLY) {
  const host = handle.slice(handle.lastIndexOf("@") + 1);
  await scenario("L10", host, async () => {
    const since = maxId((await state()).inbox);
    const follow = await followRemote(handle);
    const deadline = Date.now() + OBSERVE_MS;
    let rows: InboxEntry[] = [];
    for (;;) {
      rows = inboxFromHost((await lab.state(since)).inbox, host);
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(5_000, left));
    }
    const types = [...new Set(rows.map((row) => row.type))].slice(0, 5).join(", ");
    const rejected = rows.filter((row) => row.outcome.startsWith("rejected")).length;
    return `${handle} (${follow.actor}) accepted; ${rows.length} inbound from ${host} in ${Math.round(OBSERVE_MS / 1000)}s` +
      `${types ? ` (${types})` : ""}${rejected ? `, ${rejected} rejected` : ""}`;
  });
}

// L9: delete what the run created, undo what it left changed, leave every community it joined, then
// assert the end state. Works from the ids file, so it tolerates a run that stopped half way.
if (cleanupOnly || !keep) {
  await scenario("L9", PEER, async () => {
    const before = await state();
    const failures: string[] = [];
    const checks: [string, () => Promise<unknown>][] = [];
    const check = (label: string, probe: () => Promise<unknown>) => checks.push([label, probe]);
    /** One cleanup step. If it fails and nothing is left to undo, that is fine; otherwise it is a failure. */
    const step = async (label: string, run: () => Promise<unknown>, nothingLeft: () => Promise<boolean>) => {
      try {
        await run();
      } catch (error) {
        if (await nothingLeft().catch(() => false)) return;
        failures.push(`${label}: ${errorMessage(error)}`);
        console.log(`  cleanup step failed, ${label}: ${errorMessage(error).slice(0, 200)}`);
      }
    };
    const deletedOnLab = (uri: string) => async () => labObject(await state(), uri)?.deleted;
    const commentHidden = async (postId: number, uri: string) => {
      const comment = await findComment(postId, uri);
      return !comment || comment.deleted || comment.removed;
    };

    // What L7 may have left changed: the text post locked, the comment removed. The ids say so, and so does the lab.
    const { textPostUri, textPostId, piefedCommentUri } = ids;
    if (textPostUri && (ids.textPostLocked || labObject(before, textPostUri)?.locked)) {
      const locked = async () =>
        Boolean(labObject(await state(), textPostUri)?.locked) ||
        (textPostId !== undefined && (await piefed.getPost(token, textPostId)).locked);
      await step("unlock the L3 text post", async () => {
        await labModerate("unlock", textPostUri);
        await wait("PieFed to show the L3 text post unlocked", async () => !(await locked()));
      }, async () => !(await locked()));
      check("the L3 text post to be unlocked", async () => !(await locked()));
    }
    if (
      piefedCommentUri && textPostId !== undefined && liveOnLab(before, piefedCommentUri) &&
      (ids.commentRemoved || labObject(before, piefedCommentUri)?.removed)
    ) {
      const postId = textPostId;
      const removed = async () => {
        const object = labObject(await state(), piefedCommentUri);
        return !object?.deleted && (Boolean(object?.removed) || (await commentHidden(postId, piefedCommentUri)));
      };
      await step("restore the L4 comment", async () => {
        await labModerate("restore", piefedCommentUri);
        await wait("PieFed to show the L4 comment restored", async () => !(await removed()));
      }, async () => !(await removed()));
      check("the L4 comment to be restored", async () => !(await removed()));
    }

    // Votes by the test account on this run's objects, before the objects go.
    const targets: { uri?: string; id?: number; comment: boolean }[] = [
      { uri: ids.textPostUri, id: ids.textPostId, comment: false },
      { uri: ids.linkPostUri, id: ids.linkPostId, comment: false },
      { uri: ids.piefedPostUri, id: ids.piefedPostId, comment: false },
      { uri: ids.remotePostUri, id: ids.remotePostId, comment: false },
      { uri: ids.piefedCommentUri, id: ids.piefedCommentId, comment: true },
      { uri: ids.remoteCommentUri, id: ids.remoteCommentId, comment: true },
    ];
    const runUris = new Set(targets.flatMap((target) => (target.uri ? [target.uri] : [])));
    const testVotes = (s: FedditState) => s.votes.filter((v) => v.voter_uri === PIEFED_ACTOR && runUris.has(v.object_uri));
    for (const vote of testVotes(before)) {
      const target = targets.find((t) => t.uri === vote.object_uri);
      const id = target?.id;
      await step(`undo the vote on ${vote.object_uri}`, async () => {
        if (id === undefined) throw new Error("no PieFed id to undo it with");
        await (target?.comment ? piefed.voteComment(token, id, 0) : piefed.votePost(token, id, 0));
      }, async () => !testVotes(await state()).some((v) => v.object_uri === vote.object_uri));
    }
    check("the test account to have no votes on this run's objects", async () => testVotes(await state()).length === 0);

    // The test account's comment on the L8 post, then the lab author's L8 post itself.
    const deleteComment = async (what: string, postId?: number, commentId?: number, uri?: string) => {
      if (commentId === undefined || !uri) return;
      await step(`delete the ${what} comment on PieFed`, async () => {
        if (postId === undefined) throw new Error("no post id to check the comment against");
        await assertOurComment(postId, commentId, uri);
        await piefed.deleteComment(token, commentId);
      }, async () => postId !== undefined && (await commentHidden(postId, uri)));
      if (liveOnLab(before, uri)) check(`the lab to mark the ${what} comment deleted`, deletedOnLab(uri));
    };
    await deleteComment("L8", ids.remotePostId, ids.remoteCommentId, ids.remoteCommentUri);
    if (ids.remotePostUri) {
      const uri = ids.remotePostUri;
      const object = labObject(before, uri);
      if (object && !object.deleted) {
        await step("delete the L8 post from the lab", async () => {
          assertOurLabPost(object);
          await lab.call("delete", { object: uri });
        }, async () => Boolean(labObject(await state(), uri)?.deleted));
      }
      const postId = ids.remotePostId;
      if (postId !== undefined) check("PieFed to hide the L8 post", () => postGone(postId));
    }

    // The test account's own post and comment in the lab community.
    await deleteComment("L4", ids.textPostId, ids.piefedCommentId, ids.piefedCommentUri);
    if (ids.piefedPostId !== undefined && ids.piefedPostUri) {
      const [postId, uri] = [ids.piefedPostId, ids.piefedPostUri];
      await step("delete the L4 post on PieFed", async () => {
        await assertOurPost(postId, uri);
        await piefed.deletePost(token, postId);
      }, () => postGone(postId));
      if (liveOnLab(before, uri)) check("the lab to mark the L4 post deleted", deletedOnLab(uri));
    }

    // Leave the lab community (test account) and everything the lab author followed.
    const testFollowers = (s: FedditState) => s.followers.filter((f) => f.actor_uri === PIEFED_ACTOR);
    if (ids.labCommunityId !== undefined || testFollowers(before).length > 0) {
      await step("unfollow the lab community on PieFed", async () => {
        const id = ids.labCommunityId ?? (await piefed.resolveCommunity(token, LAB_HANDLE)).id;
        await piefed.unfollow(token, id);
      }, async () => testFollowers(await state()).length === 0);
    }
    check("the lab to hold no follower row for the test account", async () => testFollowers(await state()).length === 0);

    const authorFollows = (s: FedditState) => s.following.filter((f) => f.local_identifier === `u.${AUTHOR}`);
    const undos: string[] = [];
    for (const { remote_uri: actor } of authorFollows(before)) {
      await step(`unfollow ${actor} from the lab`, async () => {
        undos.push((await lab.call<{ activity: string }>("unfollow", { follower: AUTHOR, target: actor })).activity);
      }, async () => !authorFollows(await state()).some((f) => f.remote_uri === actor));
    }
    check("the lab author to follow nothing", async () => authorFollows(await state()).length === 0);
    for (const undo of undos) {
      check(`the lab to deliver Undo(Follow) ${undo}`, async () => {
        const row = (await state()).outbox.recent.find((r) => r.activity_id === undo);
        if (row?.status === "failed") throw new Error(`delivery to ${row.inbox} failed: ${row.last_status} ${row.last_error}`);
        return row?.status === "delivered";
      });
    }

    const unmet = (await Promise.all(checks.map(async ([label, probe]) => {
      try {
        await wait(label, probe);
        return [];
      } catch (error) {
        return [errorMessage(error)];
      }
    }))).flat();
    failures.push(...unmet);
    if (failures.length > 0) throw new Error(failures.join("; "));
    remember({ textPostLocked: false, commentRemoved: false });
    return `${checks.length} final-state checks passed; the L3 posts stay in !${LAB_COMMUNITY}`;
  });
}

// ---------------------------------------------------------------- summary

console.log("\nSummary");
for (const result of results) console.log(`  ${result.scenario.padEnd(4)} ${result.status.toUpperCase().padEnd(5)} ${result.peer}`);
try {
  const final = await state();
  // The whole of /spike/state (outbox snapshot, followers, votes, inbox log) is the evidence for the run's claims.
  writeFileSync(
    new URL(`live-${RUN}${cleanupOnly ? "-cleanup" : ""}-state.json`, CAPTURES),
    `${JSON.stringify(final, null, 2)}\n`,
  );
  console.log(`\nRemote followers of the lab now (/spike/state.followers), ${final.followers.length}:`);
  for (const f of final.followers) {
    console.log(`  ${f.local_identifier}  ${f.actor_uri}${f.actor_uri === PIEFED_ACTOR ? "  (the PieFed test account)" : ""}`);
  }
} catch (error) {
  console.log(`\nCould not read the lab's followers: ${errorMessage(error)}`);
}
console.log(`\nids: captures/live-${RUN}-ids.json; lab state: captures/live-${RUN}${cleanupOnly ? "-cleanup" : ""}-state.json`);

finish(cleanupOnly ? `live-${RUN}-cleanup.json` : `live-${RUN}.json`, RUN);
