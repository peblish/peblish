// `make collision`: a Person and a Group with the same name on Feddit.
// WebFinger answers acct:name with the Person first and the Group as a second
// `self` link. Lemmy 0.19.21 takes the first link it can parse for `!name` too,
// so C1 fails there (see RESULT.md); PieFed picks the link by type.
import { FEDDIT, feddit, http, type Peer, PEERS, recorder, runId } from "./lib.ts";

const peers: Peer[] = process.argv.slice(2).filter((a): a is keyof typeof PEERS => a in PEERS).map((n) => PEERS[n]);
if (peers.length === 0) peers.push(PEERS.lemmy, PEERS.piefed);
const { scenario, finish } = recorder();
const RUN = runId();
const NAME = `x${RUN}`;
const host = new URL(FEDDIT).host;

await feddit.call("actors", { kind: "Person", name: NAME, displayName: `Collision person ${RUN}` });
await feddit.call("actors", { kind: "Group", name: NAME, displayName: `Collision group ${RUN}`, moderators: ["alice"] });

await scenario("C0", "feddit", async () => {
  const finger = await http<{ links: { rel: string; type?: string; href?: string }[] }>(
    "GET", `${FEDDIT}/.well-known/webfinger`, { query: { resource: `acct:${NAME}@${host}` } });
  const selves = finger.links.filter((l) => l.rel === "self").map((l) => l.href);
  if (selves[0] !== `${FEDDIT}/ap/u.${NAME}` || selves[1] !== `${FEDDIT}/ap/c.${NAME}`) {
    throw new Error(`unexpected self links ${JSON.stringify(selves)}`);
  }
  return `self links: ${selves.join(", ")}`;
});

for (const peer of peers) {
  const token = await peer.login(peer.user);
  await scenario("C1", peer.name, async () => {
    const community = await peer.resolveCommunity(token, `!${NAME}@${host}`);
    return `!${NAME} resolved to community ${community.id}`;
  }, peer.name === "lemmy" ? "Lemmy 0.19.21 takes the first WebFinger self link for !name too" : undefined);
  await scenario("C2", peer.name, async () => {
    const person = await peer.mod.resolvePerson(token, `@${NAME}@${host}`);
    return `@${NAME} resolved to person ${person}`;
  });
  // The fallback when a handle is ambiguous: paste the community URL.
  await scenario("C3", peer.name, async () => {
    const community = await peer.resolveCommunity(token, `${FEDDIT}/c/${NAME}`);
    return `${FEDDIT}/c/${NAME} resolved to community ${community.id}`;
  });
}

// The instance actor at / (src/instance.ts) and its consistency with NodeInfo.
await scenario("I1", "feddit", async () => {
  const response = await fetch(`${FEDDIT}/`, { headers: { accept: "application/activity+json" } });
  const actor = (await response.json()) as Record<string, unknown> & {
    publicKey?: { id?: string; owner?: string; publicKeyPem?: string };
    endpoints?: { sharedInbox?: string };
  };
  const nodeinfo21 = await http<{ metadata: { nodeName?: string } }>("GET", `${FEDDIT}/nodeinfo/2.1`);
  const nodeinfo20 = await http<{ metadata: { nodeName?: string } }>("GET", `${FEDDIT}/nodeinfo/2.0`);
  const problems = [
    response.headers.get("content-type")?.includes("activity+json") ? null : `content-type ${response.headers.get("content-type")}`,
    actor.type === "Application" ? null : `type ${String(actor.type)}`,
    actor.id === `${FEDDIT}/` ? null : `id ${String(actor.id)}`,
    actor.preferredUsername === host ? null : `preferredUsername ${String(actor.preferredUsername)}`,
    actor.inbox === `${FEDDIT}/inbox` && actor.endpoints?.sharedInbox === `${FEDDIT}/inbox` ? null : "inbox is not the shared inbox",
    actor.publicKey?.id === `${FEDDIT}/#main-key` && actor.publicKey.owner === `${FEDDIT}/` ? null : "publicKey id or owner",
    actor.publicKey?.publicKeyPem?.startsWith("-----BEGIN PUBLIC KEY-----") ? null : "publicKeyPem",
    actor.name === nodeinfo21.metadata.nodeName && actor.name === nodeinfo20.metadata.nodeName ? null : `name ${String(actor.name)} vs NodeInfo`,
  ].filter((problem) => problem != null);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `Application ${actor.id}, key ${actor.publicKey?.id}, inbox ${actor.inbox}, name "${actor.name}" = NodeInfo 2.0/2.1 nodeName`;
});

finish("collision-results.json", RUN);
