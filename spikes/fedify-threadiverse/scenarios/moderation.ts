// `make moderation [PEERS=...]`: the moderation set (gate G2 slice 2).
//  S10-S13  Feddit's moderator acts in !spike; asserts the peer's state.
//  S14      the peer's user reports a Feddit post; asserts the exact Flag and
//           the report Feddit queued.
//  M0-M4    the peer's moderator acts in its own community, which Feddit
//           follows; asserts the exact activity that arrived (type, actor,
//           object, community, Undo contents, status) and Feddit's new state.
//  P0-P5    a peer user is made a moderator of !spike and moderates content
//           there from its own server; Feddit authorizes it against its
//           moderator list, applies it and relays it; the other peer shows it.
// Raw records go to captures/moderation/, results to captures/moderation-results.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  FEDDIT,
  feddit,
  HttpError,
  inboxAfter,
  lastInboxId,
  NotApplicable,
  type Peer,
  PEERS,
  recorder,
  runId,
  waitFor,
} from "./lib.ts";

const args = process.argv.slice(2);
const peers: Peer[] = args.filter((a): a is keyof typeof PEERS => a in PEERS).map((name) => PEERS[name]);
if (peers.length === 0) peers.push(PEERS.lemmy, PEERS.piefed);
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
const { scenario, finish } = recorder(only);

const RUN = runId();
const SPIKE = "!spike@feddit.lab.test";
const SPIKE_URI = `${FEDDIT}/ap/c.spike`;
const MODERATOR = "alice";
const FOLLOWER = `m${RUN}`;
const FOLLOWER_URI = `${FEDDIT}/ap/u.${FOLLOWER}`;
const CAPTURES = new URL("../captures/", import.meta.url);
const OUT = new URL("moderation/", CAPTURES);
mkdirSync(OUT, { recursive: true });

const actorOf = (peer: Peer) => `${peer.origin}/u/${peer.user}`;
const adminOf = (peer: Peer) => `${peer.origin}/u/${peer.admin}`;
const communityOf = (peer: Peer) => `${peer.origin}/c/${peer.name === "lemmy" ? "lab" : "pflab"}`;
const save = (name: string, data: unknown) =>
  writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify(data, null, 2)}\n`);
const moderate = (action: string, object: string, extra: Record<string, string> = {}) =>
  feddit.call("moderate", { moderator: MODERATOR, action, object, ...extra });
const objectAt = async (uri: string) => (await feddit.state()).objects.find((o) => o.uri === uri);

type Json = Record<string, unknown>;
interface Inbound {
  ts: string;
  path: string;
  status: number;
  body: Json;
}
function inboundSince(ts: string): Inbound[] {
  return readFileSync(new URL("inbound.jsonl", CAPTURES), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Inbound)
    .filter((record) => record.ts >= ts);
}
const iri = (value: unknown) =>
  typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? String(value.id) : undefined;
const asJson = (value: unknown): Json => (value && typeof value === "object" ? value as Json : {});

async function canComment(peer: Peer, token: string, postId: number): Promise<boolean> {
  try {
    await peer.comment(token, postId, null, `ban probe ${Date.now()}`);
    return true;
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
}

await feddit.call("actors", { kind: "Person", name: FOLLOWER, displayName: `Mod probe ${RUN}` });

interface PeerSetup {
  peer: Peer;
  userToken: string;
  adminToken: string;
  spikeId: number;
}
const setups: PeerSetup[] = [];

for (const peer of peers) {
  const userToken = await peer.login(peer.user);
  const adminToken = await peer.login(peer.admin);
  const subscribe = async (token: string) => {
    const view = await peer.resolveCommunity(token, SPIKE);
    // Retried: a follow is refused while a previous run's ban is being lifted.
    await waitFor("subscription", async () => {
      const now = await peer.resolveCommunity(token, SPIKE);
      if (now.subscribed === "Subscribed") return true;
      if (now.subscribed === "NotSubscribed") await peer.follow(token, now.id);
      return false;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    return view;
  };
  // A second follower on the peer. Lemmy unsubscribes a banned user and then
  // rejects the community's Announces when nobody there follows it
  // (community_has_no_followers), which would swallow the unban.
  await subscribe(adminToken);
  await moderate("unban", actorOf(peer), { community: "spike" }).catch(() => undefined); // leftover from a failed run
  const spike = await subscribe(userToken);
  setups.push({ peer, userToken, adminToken, spikeId: spike.id });

  // Targets in !spike: one Feddit post, one post by the peer's user.
  const fedditPost = await feddit.call("post", { author: MODERATOR, community: "spike", title: `Mod target ${peer.name} ${RUN}`, body: "Moderation target." });
  const onPeer = await waitFor("Feddit post on the peer", async () =>
    (await peer.listPosts(userToken, spike.id)).find((p) => p.apId === fedditPost.uri));
  const peerPost = await peer.createPost(userToken, spike.id, `Peer post ${peer.name} ${RUN}`, "To be removed by Feddit's moderator.");
  await waitFor("peer post stored on Feddit", async () => objectAt(peerPost.apId));

  const toggle = async (
    id: string,
    on: { action: string; object: string; extra?: Record<string, string> },
    off: { action: string },
    probe: () => Promise<boolean>,
    label: string,
  ) =>
    await scenario(id, peer.name, async () => {
      const sent = await moderate(on.action, on.object, on.extra);
      await waitFor(`${label} on the peer`, probe);
      const undone = await moderate(off.action, on.object, on.extra);
      await waitFor(`${label} undone on the peer`, async () => !(await probe()));
      save(`${peer.name}-${id}-sent`, { [on.action]: sent.json, [off.action]: undone.json });
      return `${on.action} applied and ${off.action} reverted it`;
    });

  await toggle("S10", { action: "remove", object: peerPost.apId, extra: { reason: `S10 ${RUN}` } }, { action: "restore" },
    async () => (await peer.getPost(userToken, peerPost.id)).removed, "removal");
  await toggle("S11", { action: "lock", object: fedditPost.uri! }, { action: "unlock" },
    async () => (await peer.getPost(userToken, onPeer.id)).locked, "lock");
  await toggle("S12", { action: "ban", object: actorOf(peer), extra: { community: "spike", reason: `S12 ${RUN}` } }, { action: "unban" },
    async () => !(await canComment(peer, userToken, onPeer.id)), "community ban");
  await toggle("S13", { action: "feature", object: fedditPost.uri! }, { action: "unfeature" },
    async () => (await peer.getPost(userToken, onPeer.id)).featured, "sticky");

  await scenario("S14", peer.name, async () => {
    const since = new Date().toISOString();
    const reason = `S14 report ${RUN}`;
    await peer.mod.reportPost(userToken, onPeer.id, reason);
    const flag = await waitFor("the Flag at Feddit", async () =>
      inboundSince(since).find((r) => r.body.type === "Flag" && r.body.actor === actorOf(peer) &&
        [r.body.object].flat().map(iri).includes(fedditPost.uri)));
    if (flag.status !== 202) throw new Error(`Flag answered ${flag.status}`);
    const report = await waitFor("the queued report", async () =>
      (await feddit.state()).reports.find((r) => r.object_uri === fedditPost.uri && r.reporter_uri === actorOf(peer)));
    if (report.community_uri !== SPIKE_URI) throw new Error(`report filed under ${report.community_uri}`);
    save(`${peer.name}-S14-received`, { flag, report });
    return `Flag from ${peer.user} on the post (202); report queued for !spike with reason "${report.reason}"`;
  });

  // ------------------------------------------------ inbound: the peer moderates its own community
  const community = communityOf(peer);
  const handle = `!${community.split("/").at(-1)}@${new URL(peer.origin).host}`;
  const followed = await scenario("M0", peer.name, async () => {
    const result = await feddit.call<{ remote: string; activity: string }>("follow", { follower: FOLLOWER, target: handle });
    if (result.remote !== community) throw new Error(`resolved ${result.remote}`);
    await waitFor("the Accept of this Follow", async () =>
      (await feddit.state()).following.some((f) =>
        f.local_identifier === `u.${FOLLOWER}` && f.remote_uri === community && f.follow_id === result.activity && f.accepted));
    return `${FOLLOWER} follows ${handle}; Accept matched Follow ${result.activity}`;
  });
  if (!followed) continue;
  // Written by the regular user, moderated by the admin: a mod removal, not a self-delete.
  const ownForUser = await peer.resolveCommunity(userToken, handle);
  const own = await peer.resolveCommunity(adminToken, handle);
  const native = await peer.createPost(userToken, ownForUser.id, `Native mod target ${RUN}`, "Moderated by the peer.");
  await waitFor("native post on Feddit", async () => objectAt(native.apId));
  const followerId = await peer.mod.resolvePerson(adminToken, FOLLOWER_URI);
  const banned = async () => (await feddit.state()).bans.some((b) => b.community_uri === community && b.actor_uri === FOLLOWER_URI);

  const steps: {
    id: string;
    action: string;
    act: () => Promise<void>;
    inner: string;
    undone?: string;
    object: string;
    target?: string;
    state: () => Promise<boolean>;
  }[] = [
    { id: "M1", action: "remove", act: () => peer.mod.removePost(adminToken, native.id, true, `M1 ${RUN}`), inner: "Delete", object: native.apId,
      state: async () => (await objectAt(native.apId))?.removed === true },
    { id: "M1", action: "restore", act: () => peer.mod.removePost(adminToken, native.id, false, `M1 ${RUN}`), inner: "Undo", undone: "Delete", object: native.apId,
      state: async () => (await objectAt(native.apId))?.removed === false },
    { id: "M2", action: "lock", act: () => peer.mod.lockPost(adminToken, native.id, true), inner: "Lock", object: native.apId,
      state: async () => (await objectAt(native.apId))?.locked === true },
    { id: "M2", action: "unlock", act: () => peer.mod.lockPost(adminToken, native.id, false), inner: "Undo", undone: "Lock", object: native.apId,
      state: async () => (await objectAt(native.apId))?.locked === false },
    { id: "M3", action: "feature", act: () => peer.mod.featurePost(adminToken, native.id, true), inner: "Add", object: native.apId, target: `${community}/featured`,
      state: async () => (await objectAt(native.apId))?.stickied === true },
    { id: "M3", action: "unfeature", act: () => peer.mod.featurePost(adminToken, native.id, false), inner: "Remove", object: native.apId, target: `${community}/featured`,
      state: async () => (await objectAt(native.apId))?.stickied === false },
    { id: "M4", action: "ban", act: () => peer.mod.ban(adminToken, own.id, followerId, true, `M4 ${RUN}`), inner: "Block", object: FOLLOWER_URI, target: community,
      state: banned },
    { id: "M4", action: "unban", act: () => peer.mod.ban(adminToken, own.id, followerId, false, `M4 ${RUN}`), inner: "Undo", undone: "Block", object: FOLLOWER_URI,
      state: async () => !(await banned()) },
  ];
  for (const step of steps) {
    await scenario(step.id, peer.name, async () => {
      const since = new Date().toISOString();
      const before = await lastInboxId();
      await step.act();
      // The exact activity: announced by the community, by the peer's moderator, about this object.
      const arrived = await waitFor(`Announce(${step.inner}) from ${community}`, async () =>
        inboundSince(since).find((r) => {
          const inner = asJson(r.body.object);
          if (r.body.type !== "Announce" || r.body.actor !== community || inner.type !== step.inner || inner.actor !== adminOf(peer)) return false;
          const subject = step.undone ? asJson(inner.object) : inner;
          if (step.undone && subject.type !== step.undone) return false;
          if (iri(subject.object) !== step.object) return false;
          return !step.target || iri(subject.target) === step.target;
        }), { timeoutMs: 20_000 });
      if (arrived.status !== 202) throw new Error(`Announce answered ${arrived.status}`);
      const innerId = iri(arrived.body.object)!;
      // Applied once, from whichever copy came first (Lemmy also sends a ban direct).
      const outcomes = async () => (await inboxAfter(before)).filter((e) => e.activity_id === innerId);
      const applied = await waitFor("Feddit applied it", async () => {
        const entry = (await outcomes()).find((e) => !/^(rejected|ignored)/.test(e.outcome));
        return entry && (await step.state()) && entry;
      }, { timeoutMs: 15_000 }).catch(async (error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : error}; outcomes: ${(await outcomes()).map((e) => e.outcome).join(" | ")}`);
      });
      save(`${peer.name}-${step.id}-${step.action}-received`, { arrived, applied });
      return `${step.action}: Announce(${step.undone ? `Undo(${step.undone})` : step.inner}) by ${peer.admin} -> ${arrived.status}; Feddit ${applied.outcome}`;
    }, peer.name === "piefed" && step.action === "unban"
      ? "PieFed 1.8.11's unban task crashes (ap_datetime on a string), so no Undo(Block) is sent; see captures/piefed-celery-unban-error.log"
      : undefined);
  }
}

// ------------------------------------------------ a peer user moderates !spike from its own server
for (const mod of setups) {
  const other = setups.find((s) => s !== mod);
  if (!other) break;
  const { peer } = mod;
  const modUri = actorOf(peer);
  // PieFed applies the Add to its database but its API serves a cached
  // moderator list (cached_modlist_for_community) that a federated Add does
  // not invalidate, so only Lemmy's listing is asserted; P1-P4 then test
  // whether each peer actually grants the new moderator its rights.
  const listed = async (setup: PeerSetup) => (await setup.peer.mod.moderators(setup.userToken, setup.spikeId)).includes(modUri);
  const made = await scenario("P0", peer.name, async () => {
    await feddit.call("moderators", { community: "spike", actor: modUri, by: MODERATOR });
    const lemmySide = [mod, other].find((s) => s.peer.name === "lemmy")!;
    await waitFor(`lemmy lists ${peer.user} as a moderator of !spike`, () => listed(lemmySide), { timeoutMs: 60_000, intervalMs: 2_000 });
    const piefedSide = [mod, other].find((s) => s.peer.name === "piefed")!;
    const piefedListed = await listed(piefedSide);
    return `Add(${peer.user}) to !spike's moderators announced; lemmy lists it; piefed API ${piefedListed ? "lists it" : "still shows its cached list"}`;
  });
  if (!made) continue;
  // A post by the other peer's user, seen on both peers.
  const target = await other.peer.createPost(other.userToken, other.spikeId, `P target ${other.peer.name} ${RUN}`, "Moderated by a remote moderator.");
  await waitFor("target on Feddit", async () => objectAt(target.apId));
  const onMod = await waitFor(`target on ${peer.name}`, async () =>
    (await peer.listPosts(mod.userToken, mod.spikeId)).find((p) => p.apId === target.apId));
  const otherView = () => other.peer.getPost(other.userToken, target.id);

  const relayed = async (
    id: string,
    label: string,
    act: (on: boolean) => Promise<void>,
    fedditFlag: (o: NonNullable<Awaited<ReturnType<typeof objectAt>>>) => boolean,
    otherFlag: () => Promise<boolean>,
  ) =>
    await scenario(id, peer.name, async () => {
      const before = await lastInboxId();
      await act(true);
      await waitFor(`${label} applied on Feddit`, async () => {
        const object = await objectAt(target.apId);
        return object != null && fedditFlag(object);
      });
      const entry = (await inboxAfter(before)).find((e) => e.actor === modUri && e.via === "direct" && !/^(ignored|rejected)/.test(e.outcome));
      if (!entry?.outcome.includes("as moderator") || !entry.outcome.includes("announced")) {
        throw new Error(`Feddit outcome: ${entry?.outcome ?? "none"}`);
      }
      await waitFor(`${label} relayed to ${other.peer.name}`, otherFlag);
      await act(false);
      await waitFor(`${label} undone on Feddit`, async () => {
        const object = await objectAt(target.apId);
        return object != null && !fedditFlag(object);
      });
      await waitFor(`${label} undone on ${other.peer.name}`, async () => !(await otherFlag()));
      return `${peer.user} on ${peer.name} -> Feddit "${entry.outcome}" -> ${other.peer.name}, then undone`;
    });

  await relayed("P1", "removal", (on) => peer.mod.removePost(mod.userToken, onMod.id, on, `P1 ${RUN}`),
    (o) => o.removed, async () => (await otherView()).removed);
  await relayed("P2", "lock", (on) => peer.mod.lockPost(mod.userToken, onMod.id, on),
    (o) => o.locked, async () => (await otherView()).locked);
  await relayed("P3", "sticky", (on) => peer.mod.featurePost(mod.userToken, onMod.id, on),
    (o) => o.stickied, async () => (await otherView()).featured);
  await scenario("P4", peer.name, async () => {
    const victim = actorOf(other.peer);
    const personId = await peer.mod.resolvePerson(mod.userToken, victim);
    const isBanned = async () => (await feddit.state()).bans.some((b) => b.community_uri === SPIKE_URI && b.actor_uri === victim && b.by_actor === modUri);
    try {
      await peer.mod.ban(mod.userToken, mod.spikeId, personId, true, `P4 ${RUN}`);
    } catch (error) {
      // PieFed 1.8.11's API bans only in communities it hosts.
      if (error instanceof HttpError && error.body.includes("not local to this instance")) {
        throw new NotApplicable(`${peer.name} API refuses bans in remote communities: ${error.body.slice(0, 120)}`);
      }
      throw error;
    }
    await waitFor("ban recorded on Feddit", isBanned);
    await waitFor(`${other.peer.user} cannot comment on ${other.peer.name}`, async () => !(await canComment(other.peer, other.userToken, target.id)));
    await peer.mod.ban(mod.userToken, mod.spikeId, personId, false, `P4 ${RUN}`);
    await waitFor("ban lifted on Feddit", async () => !(await isBanned()));
    await waitFor(`${other.peer.user} can comment again`, async () => canComment(other.peer, other.userToken, target.id));
    return `${peer.user} banned and unbanned ${other.peer.user} in !spike; Feddit recorded it and ${other.peer.name} enforced it`;
  });
  await scenario("P5", peer.name, async () => {
    await feddit.call("moderators", { community: "spike", actor: modUri, by: MODERATOR, remove: true });
    await waitFor(`${peer.name} no longer lists ${peer.user}`, async () =>
      !(await peer.mod.moderators(mod.userToken, mod.spikeId)).includes(modUri), { timeoutMs: 60_000, intervalMs: 2_000 });
    return `Remove(${peer.user}) from !spike's moderators announced and applied`;
  });
}

finish("moderation-results.json", RUN);
