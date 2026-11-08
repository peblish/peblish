// `make moderation` (second half): activities Feddit must refuse. The rogue
// lab peer (rogue.ts) signs each one with a real key, so a refusal comes from
// Feddit's rules, not from a bad signature (N0 is the control that it can
// deliver at all). Each case asserts the inbox_log outcome is a rejection, the
// target is unchanged, and the refusal is in captures/rejected.jsonl.
// Results in captures/authz-results.json, raw records in captures/authz/.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FEDDIT, feddit, http, inboxAfter, lastInboxId, PEERS, recorder, runId, waitFor } from "./lib.ts";

const { scenario, finish } = recorder();
const RUN = runId();
const ROGUE = "https://rogue.lab.test";
const MALLORY = `${ROGUE}/u/mallory`;
const FAKE = `${ROGUE}/c/fake`;
const SPIKE = `${FEDDIT}/ap/c.spike`;
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const lemmy = PEERS.lemmy;
const LAB = `${lemmy.origin}/c/lab`;
const LEMMYUSER = `${lemmy.origin}/u/${lemmy.user}`;
const WATCHER = `n${RUN}`;
const CAPTURES = new URL("../captures/", import.meta.url);
const OUT = new URL("authz/", CAPTURES);
mkdirSync(OUT, { recursive: true });

const rid = (type: string) => `${ROGUE}/activities/${type}/${randomUUID()}`;
const send = (as: string, activity: Record<string, unknown>) =>
  http<{ status: number; body: string }>("POST", `${ROGUE}/control/send`, { body: { as, activity } });
const objectAt = async (uri: string) => (await feddit.state()).objects.find((o) => o.uri === uri);

function rejectedCaptures(id: string): unknown[] {
  return readFileSync(new URL("rejected.jsonl", CAPTURES), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id?: string })
    .filter((record) => record.id === id);
}

/** Sends `activity` as `as`; expects Feddit to log `id` as rejected and `unchanged` to hold. */
async function refuse(
  scenarioId: string,
  label: string,
  as: string,
  activity: Record<string, unknown>,
  unchanged: () => Promise<string | null>,
  loggedId = String(activity.id),
) {
  await scenario(scenarioId, "rogue", async () => {
    const before = await lastInboxId();
    const response = await send(as, activity);
    if (response.status !== 202) throw new Error(`Feddit answered ${response.status}: ${response.body}`);
    const entry = await waitFor(`rejection of ${loggedId}`, async () =>
      (await inboxAfter(before)).find((e) => e.activity_id === loggedId), { timeoutMs: 15_000 });
    if (!entry.outcome.startsWith("rejected")) throw new Error(`not rejected: ${entry.outcome}`);
    const changed = await unchanged();
    if (changed) throw new Error(`state changed: ${changed}`);
    const captured = rejectedCaptures(loggedId);
    if (captured.length === 0) throw new Error("no record in captures/rejected.jsonl");
    writeFileSync(new URL(`${scenarioId}.json`, OUT), `${JSON.stringify({ sent: activity, response, entry, captured }, null, 2)}\n`);
    return `${label}: ${entry.outcome}`;
  });
}

// ------------------------------------------------ setup
await http("POST", `${ROGUE}/control/reset`);
const lemmyToken = await lemmy.login(lemmy.user);
const spikeOnLemmy = await lemmy.resolveCommunity(lemmyToken, "!spike@feddit.lab.test");
if (spikeOnLemmy.subscribed !== "Subscribed") await lemmy.follow(lemmyToken, spikeOnLemmy.id);
await feddit.call("actors", { kind: "Person", name: WATCHER, displayName: `Authz watcher ${RUN}` });
// Feddit follows the rogue group (so its Announces pass the "followed group" check) and Lemmy's !lab.
for (const target of [FAKE, "!lab@lemmy.lab.test"]) {
  const result = await feddit.call<{ remote: string; activity: string }>("follow", { follower: WATCHER, target });
  await waitFor(`Accept from ${result.remote}`, async () =>
    (await feddit.state()).following.some((f) => f.local_identifier === `u.${WATCHER}` && f.follow_id === result.activity && f.accepted));
}
// T1: a Lemmy user's post in Feddit's !spike. T2: a Lemmy user's post in Lemmy's !lab.
await waitFor("subscribed to !spike", async () => (await lemmy.resolveCommunity(lemmyToken, "!spike@feddit.lab.test")).subscribed === "Subscribed");
const t1 = await lemmy.createPost(lemmyToken, spikeOnLemmy.id, `Authz T1 ${RUN}`, "Target in !spike.");
const lab = await lemmy.resolveCommunity(lemmyToken, "!lab@lemmy.lab.test");
const t2 = await lemmy.createPost(lemmyToken, lab.id, `Authz T2 ${RUN}`, "Target in !lab.");
await waitFor("T1 and T2 on Feddit", async () => (await objectAt(t1.apId)) && (await objectAt(t2.apId)));
await lemmy.votePost(lemmyToken, t1.id, 1);
await waitFor("lemmyuser's vote on T1", async () => (await feddit.state()).votes.some((v) => v.voter_uri === LEMMYUSER && v.object_uri === t1.apId));
const T1 = t1.apId;
const T2 = t2.apId;

const intact = (uri: string) => async () => {
  const object = await objectAt(uri);
  if (!object) return "object missing";
  const flags = (["deleted", "removed", "locked", "stickied"] as const).filter((flag) => object[flag]);
  return flags.length > 0 ? `${uri} is now ${flags.join(", ")}` : null;
};

// ------------------------------------------------ N0: control
await scenario("N0", "rogue", async () => {
  const before = await lastInboxId();
  const id = rid("create");
  const note = { id: `${ROGUE}/comment/${randomUUID()}`, type: "Note", attributedTo: MALLORY, inReplyTo: T1, content: "<p>control</p>", to: [PUBLIC], cc: [SPIKE], audience: SPIKE };
  const response = await send(MALLORY, { id, type: "Create", actor: MALLORY, object: note, to: [PUBLIC], cc: [SPIKE], audience: SPIKE });
  const entry = await waitFor("control applied", async () => (await inboxAfter(before)).find((e) => e.activity_id === id));
  if (!entry.outcome.startsWith("stored")) throw new Error(entry.outcome);
  return `signed Create(Note) from mallory -> ${response.status}; Feddit: ${entry.outcome}`;
});

// ------------------------------------------------ direct, by a non-moderator
await refuse("N1", "non-moderator removes a post", MALLORY,
  { id: rid("delete"), type: "Delete", actor: MALLORY, object: T1, summary: "spam", to: [PUBLIC], cc: [SPIKE], audience: SPIKE }, intact(T1));
await refuse("N2", "non-author edits a post", MALLORY,
  { id: rid("update"), type: "Update", actor: MALLORY, to: [PUBLIC], cc: [SPIKE], audience: SPIKE,
    object: { id: T1, type: "Page", attributedTo: MALLORY, name: "hijacked", content: "<p>hijacked</p>", audience: SPIKE, to: [SPIKE, PUBLIC] } },
  async () => ((await objectAt(T1))?.title === `Authz T1 ${RUN}` ? null : "title changed"));
await refuse("N3", "non-moderator locks a post", MALLORY,
  { id: rid("lock"), type: "Lock", actor: MALLORY, object: T1, to: [PUBLIC], cc: [SPIKE], audience: SPIKE }, intact(T1));
await refuse("N4", "non-moderator features a post", MALLORY,
  { id: rid("add"), type: "Add", actor: MALLORY, object: T1, target: `${SPIKE}/featured`, to: [PUBLIC], cc: [SPIKE], audience: SPIKE }, intact(T1));
await refuse("N5", "non-moderator bans a user", MALLORY,
  { id: rid("block"), type: "Block", actor: MALLORY, object: LEMMYUSER, target: SPIKE, to: [PUBLIC], cc: [SPIKE], audience: SPIKE },
  async () => ((await feddit.state()).bans.some((b) => b.actor_uri === LEMMYUSER) ? "ban recorded" : null));
await refuse("N6", "non-moderator makes itself a moderator", MALLORY,
  { id: rid("add"), type: "Add", actor: MALLORY, object: MALLORY, target: `${SPIKE}/moderators`, to: [PUBLIC], cc: [SPIKE], audience: SPIKE },
  async () => ((await feddit.state()).moderators.some((m) => m.actor_uri === MALLORY) ? "mallory is a moderator" : null));
await refuse("N7", "undo of another actor's vote", MALLORY,
  { id: rid("undo"), type: "Undo", actor: MALLORY, to: [PUBLIC], cc: [SPIKE],
    object: { id: rid("like"), type: "Like", actor: LEMMYUSER, object: T1 } },
  async () => ((await feddit.state()).votes.some((v) => v.voter_uri === LEMMYUSER && v.object_uri === T1) ? null : "vote removed"));
await refuse("N8", "report on content not hosted here", MALLORY,
  { id: rid("flag"), type: "Flag", actor: MALLORY, object: T2, summary: "not yours to judge", to: [LAB] },
  async () => ((await feddit.state()).reports.some((r) => r.object_uri === T2) ? "report stored" : null));

// ------------------------------------------------ signature binding (Fedify)
await scenario("N9", "rogue", async () => {
  const id = rid("delete");
  // Signed with mallory's key, but claims lemmyuser as actor.
  const response = await send(MALLORY, { id, type: "Delete", actor: LEMMYUSER, object: T1, to: [PUBLIC], cc: [SPIKE] });
  if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
  const changed = await intact(T1)();
  if (changed) throw new Error(changed);
  return `Delete claiming lemmyuser, signed by mallory -> ${response.status} (Fedify: key owner is not the actor)`;
});

// ------------------------------------------------ forged Announces from a followed group
const announce = (object: Record<string, unknown>) => ({ id: rid("announce"), type: "Announce", actor: FAKE, to: [PUBLIC], cc: [`${FAKE}/followers`], object });
{
  const inner = { id: rid("delete"), type: "Delete", actor: LEMMYUSER, object: T2, to: [PUBLIC], cc: [LAB], audience: LAB };
  await refuse("N10", "Announce of a Delete attributed to another server's author", FAKE, announce(inner), intact(T2), inner.id);
}
{
  // Claims an id on Lemmy's origin, so Feddit refetches it there: it does not exist.
  const inner = { id: `${lemmy.origin}/activities/delete/${randomUUID()}`, type: "Delete", actor: LEMMYUSER, object: T2, to: [PUBLIC], cc: [LAB] };
  const outer = announce(inner);
  await refuse("N11", "Announce of an unverifiable Delete under Lemmy's origin", FAKE, outer, intact(T2), String(outer.id));
}
{
  // mallory's own post, but announced as if it belonged to Lemmy's !lab.
  const page = { id: `${ROGUE}/post/${randomUUID()}`, type: "Page", attributedTo: MALLORY, name: "smuggled", content: "<p>smuggled</p>", audience: LAB, to: [LAB, PUBLIC] };
  const inner = { id: rid("create"), type: "Create", actor: MALLORY, object: page, to: [PUBLIC], cc: [LAB], audience: LAB };
  await refuse("N12", "Announce by a group that does not own the community", FAKE, announce(inner),
    async () => ((await objectAt(page.id)) ? "smuggled post stored" : null), inner.id);
}
{
  const outer = { ...announce({ id: rid("delete"), type: "Delete", actor: MALLORY, object: T1 }), actor: MALLORY };
  await refuse("N13", "Announce from an actor nobody follows", MALLORY, outer, intact(T1), String(outer.id));
}

// ------------------------------------------------ community rules: ban and lock
await feddit.call("moderate", { moderator: "alice", action: "ban", object: MALLORY, community: "spike", reason: `N14 ${RUN}` });
{
  const note = { id: `${ROGUE}/comment/${randomUUID()}`, type: "Note", attributedTo: MALLORY, inReplyTo: T1, content: "<p>banned</p>", to: [PUBLIC], cc: [SPIKE], audience: SPIKE };
  await refuse("N14", "banned user comments", MALLORY,
    { id: rid("create"), type: "Create", actor: MALLORY, object: note, to: [PUBLIC], cc: [SPIKE], audience: SPIKE },
    async () => ((await objectAt(note.id)) ? "comment stored" : null));
}
await feddit.call("moderate", { moderator: "alice", action: "unban", object: MALLORY, community: "spike" });
await feddit.call("moderate", { moderator: "alice", action: "lock", object: T1 });
{
  const note = { id: `${ROGUE}/comment/${randomUUID()}`, type: "Note", attributedTo: MALLORY, inReplyTo: T1, content: "<p>locked</p>", to: [PUBLIC], cc: [SPIKE], audience: SPIKE };
  await refuse("N15", "comment on a locked post", MALLORY,
    { id: rid("create"), type: "Create", actor: MALLORY, object: note, to: [PUBLIC], cc: [SPIKE], audience: SPIKE },
    async () => ((await objectAt(note.id)) ? "comment stored" : null));
}
await feddit.call("moderate", { moderator: "alice", action: "unlock", object: T1 });

finish("authz-results.json", RUN);
