// `make durability`: the outbox's delivery policy and crash recovery.
//   node scenarios/durability.ts before   policy cases D3-D7, then leaves one
//                                         delivery in flight and others queued
//   (make kills the Feddit container with SIGKILL and starts it again)
//   node scenarios/durability.ts after    D1-D2: nothing was lost
// Rogue fixture actors (rogue.ts) follow !spike, so every !spike Announce is
// also delivered to inboxes that misbehave in known ways.
// Results in captures/durability-results.json, state between phases in
// captures/durability-state.json.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { FEDDIT, feddit, http, type OutboxEntry, PEERS, recorder, runId, waitFor } from "./lib.ts";

const phase = process.argv[2];
if (phase !== "before" && phase !== "after") throw new Error("usage: durability.ts before|after");
const ROGUE = "https://rogue.lab.test";
const SPIKE = `${FEDDIT}/ap/c.spike`;
const CAPTURES = new URL("../captures/", import.meta.url);
const STATE = new URL("durability-state.json", CAPTURES);
const FIXTURES = ["loopback", "privateip", "redirector", "flaky", "down", "refuser", "slow"] as const;
const fixtureInbox: Record<(typeof FIXTURES)[number], string> = {
  loopback: "https://localhost:8443/inbox",
  privateip: "https://10.20.30.40/inbox",
  redirector: `${ROGUE}/fixture/redirect`,
  flaky: `${ROGUE}/fixture/flaky`,
  down: `${ROGUE}/fixture/down`,
  refuser: `${ROGUE}/fixture/refuse`,
  slow: `${ROGUE}/fixture/slow`,
};

const { scenario, results, finish } = recorder();
const rows = (object: string) => http<OutboxEntry[]>("GET", `${FEDDIT}/spike/outbox`, { query: { object } });
const rowFor = async (object: string, inbox: string) => (await rows(object)).find((row) => row.inbox === inbox);
const received = () => http<{ ts: string; path: string; status: number; body: { id?: string; object?: { id?: string } } }[]>("GET", `${ROGUE}/control/received`);
const post = (title: string) =>
  feddit.call<{ uri: string; activity: string }>("post", { author: "alice", community: "spike", title, body: "Delivery probe." });
const outbound = (): { url: string; status?: number; body?: { id?: string; object?: { id?: string } } }[] =>
  readFileSync(new URL("outbound.jsonl", CAPTURES), "utf8").trim().split("\n").map((line) => JSON.parse(line));

interface Saved {
  run: string;
  inFlight: { create: string; uri: string };
  queued: { create: string; uri: string };
  results: unknown[];
}

if (phase === "before") {
  const RUN = runId();
  await http("POST", `${ROGUE}/control/reset`);
  await feddit.call("outbox/hold", { hold: false }); // left over from an aborted run
  // Every fixture follows !spike from its own (misbehaving) inbox.
  for (const name of FIXTURES) {
    await http("POST", `${ROGUE}/control/send`, { body: { as: `${ROGUE}/u/${name}`, activity: {
      id: `${ROGUE}/activities/follow/${randomUUID()}`, type: "Follow", actor: `${ROGUE}/u/${name}`, object: SPIKE } } });
  }
  await waitFor("fixtures follow !spike", async () => {
    const followers = (await feddit.state()).followers.filter((f) => f.local_identifier === "c.spike");
    return FIXTURES.every((name) => followers.some((f) => f.actor_uri === `${ROGUE}/u/${name}` && f.inbox === fixtureInbox[name]));
  });

  // ---------------------------------------------- policy: one Announce, every kind of inbox
  // The Accepts to the fixtures go through the same inboxes; let them settle
  // (the `down` one takes its 13 s of retries), then arm the flaky inbox.
  await waitFor("no deliveries pending", async () => !(await feddit.state()).outbox.counts.pending, { timeoutMs: 60_000, intervalMs: 1_000 });
  await http("POST", `${ROGUE}/control/mode`, { body: { fail503: 2 } });
  const probe = await post(`D policy ${RUN}`);
  const settled = async () => {
    const all = await rows(probe.activity);
    return all.length > 0 && all.every((row) => row.status !== "pending") && all;
  };
  await waitFor("every delivery settled", settled, { timeoutMs: 40_000, intervalMs: 1_000 });
  const expect = async (id: string, name: (typeof FIXTURES)[number], check: (row: OutboxEntry) => string | null, label: string) =>
    await scenario(id, "outbox", async () => {
      const row = await rowFor(probe.activity, fixtureInbox[name]);
      if (!row) throw new Error(`no delivery to ${fixtureInbox[name]}`);
      const problem = check(row);
      if (problem) throw new Error(`${problem} (${JSON.stringify(row)})`);
      return `${label}: ${row.status} after ${row.attempts} attempt(s), last status ${row.last_status ?? "none"}${row.last_error ? `, "${row.last_error.slice(0, 90)}"` : ""}`;
    });
  await expect("D3", "refuser", (row) => row.status === "failed" && row.attempts === 1 && row.last_status === 400 ? null : "expected one attempt and a final 400",
    "permanent 400 stops at once");
  await scenario("D3b", "outbox", async () => {
    // One signed POST per attempt: no second signature scheme after a refusal.
    const posts = outbound().filter((record) => record.url === fixtureInbox.refuser && record.body?.object?.id === probe.activity);
    if (posts.length !== 1) throw new Error(`${posts.length} POSTs to the refusing inbox`);
    return "one POST to the refusing inbox (draft-cavage only; Fedify would have re-sent it with RFC 9421)";
  });
  await expect("D4", "flaky", (row) => row.status === "delivered" && row.attempts === 3 ? null : "expected delivery on the third attempt",
    "two 503s, then delivered");
  await expect("D5", "down", (row) => row.status === "failed" && row.attempts === 4 && row.last_status === 503 ? null : "expected four attempts, then failed",
    "always 503: capped");
  await expect("D6", "redirector", (row) => row.status === "failed" && row.attempts === 1 && row.last_status === 307 ? null : "expected a refused redirect",
    "redirect not followed");
  await scenario("D6b", "outbox", async () => {
    const sink = (await received()).filter((record) => record.path === "/fixture/sink");
    if (sink.length > 0) throw new Error("the redirect target received a POST");
    return "the redirect target received nothing";
  });
  for (const [id, name] of [["D7", "loopback"], ["D7b", "privateip"]] as const) {
    await expect(id, name, (row) => row.status === "failed" && row.attempts === 1 && row.last_status == null && /blocked/.test(row.last_error ?? "")
      ? null : "expected a refusal before connecting", `inbox on a ${name === "loopback" ? "name resolving to 127.0.0.1" : "RFC 1918 literal"}`);
  }
  await scenario("D7c", "outbox", async () => {
    const peers = (await rows(probe.activity)).filter((row) => row.inbox.startsWith(PEERS.lemmy.origin) || row.inbox.startsWith(PEERS.piefed.origin));
    if (peers.length < 2 || peers.some((row) => row.status !== "delivered")) throw new Error(JSON.stringify(peers));
    return "the same Announce reached Lemmy and PieFed on the first attempt";
  });

  // ---------------------------------------------- crash setup: one in flight, one queued
  await http("POST", `${ROGUE}/control/mode`, { body: { slowMs: 30_000 } });
  const inFlight = await post(`D2 in flight ${RUN}`);
  await waitFor("the slow inbox has the request open", async () =>
    (await received()).some((record) => record.path === "/fixture/slow (started)" && record.body.object?.id === inFlight.activity));
  await feddit.call("outbox/hold", { hold: true });
  const queued = await post(`D1 queued ${RUN}`);
  await waitFor("queued deliveries are pending", async () => {
    const all = await rows(queued.activity);
    return all.length > 0 && all.every((row) => row.status === "pending" && row.attempts === 0);
  });
  const saved: Saved = { run: RUN, inFlight: { create: inFlight.activity, uri: inFlight.uri }, queued: { create: queued.activity, uri: queued.uri }, results };
  writeFileSync(STATE, `${JSON.stringify(saved, null, 2)}\n`);
  console.log("Ready for SIGKILL: one delivery in flight, the rest held.");
  process.exit(results.some((result) => result.status === "fail") ? 1 : 0);
}

// ------------------------------------------------ after the crash
const saved = JSON.parse(readFileSync(STATE, "utf8")) as Saved;
results.push(...(saved.results as typeof results));

await scenario("D1", "outbox", async () => {
  const all = await waitFor("held deliveries sent after the restart", async () => {
    const list = await rows(saved.queued.create);
    const peers = list.filter((row) => row.inbox.startsWith(PEERS.lemmy.origin) || row.inbox.startsWith(PEERS.piefed.origin));
    return peers.length >= 2 && peers.every((row) => row.status === "delivered") && list;
  }, { timeoutMs: 30_000 });
  for (const peer of [PEERS.lemmy, PEERS.piefed]) {
    const token = await peer.login(peer.user);
    const spike = await peer.resolveCommunity(token, "!spike@feddit.lab.test");
    await waitFor(`the post on ${peer.name}`, async () => (await peer.listPosts(token, spike.id)).some((p) => p.apId === saved.queued.uri));
  }
  return `${all.length} deliveries queued before SIGKILL were sent after the restart; the post is on Lemmy and PieFed`;
});
await scenario("D2", "outbox", async () => {
  const row = await waitFor("the in-flight delivery re-sent after its lease expired", async () => {
    const found = await rowFor(saved.inFlight.create, fixtureInbox.slow);
    return found?.status === "delivered" && found;
  }, { timeoutMs: 40_000 });
  const posts = (await received()).filter((record) => record.path.startsWith("/fixture/slow") && record.body.object?.id === saved.inFlight.create);
  if (row.attempts < 2) throw new Error(`delivered after ${row.attempts} attempt(s)`);
  return `in flight at SIGKILL, re-claimed after the lease and delivered on attempt ${row.attempts}; the inbox saw ${posts.length} copies of the same activity id (at least once)`;
});

// Stop delivering to the fixtures.
for (const name of FIXTURES) {
  await http("POST", `${ROGUE}/control/send`, { body: { as: `${ROGUE}/u/${name}`, activity: {
    id: `${ROGUE}/activities/undo/${randomUUID()}`, type: "Undo", actor: `${ROGUE}/u/${name}`,
    object: { id: `${ROGUE}/activities/follow/${randomUUID()}`, type: "Follow", actor: `${ROGUE}/u/${name}`, object: SPIKE } } } });
}

finish("durability-results.json", saved.run);
