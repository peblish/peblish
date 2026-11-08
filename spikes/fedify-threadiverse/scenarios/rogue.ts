// A hostile or broken lab peer at https://rogue.lab.test (the `rogue` service).
// It is a test double, not a server: it signs whatever a scenario asks it to
// send, and serves actors whose inboxes misbehave on purpose.
//
//   Actors:   /u/mallory (a person, moderator of nothing on Feddit)
//             /c/fake    (a group a Feddit user can follow; it announces forgeries)
//             /u/<name>  fixtures whose `inbox` points at a private address,
//                        a redirect, a failing, a slow or a sink endpoint
//   Control:  POST /control/send  {as, inbox, activity}  sign and deliver
//             POST /control/mode  {fail503, fail400, slowMs}
//             GET  /control/received                   what reached our inboxes
//             POST /control/reset
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { signRequest } from "@fedify/fedify";

const ORIGIN = "https://rogue.lab.test";
const AS = "https://www.w3.org/ns/activitystreams";
const FEDDIT_INBOX = "https://feddit.lab.test/inbox";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const signingKey = await crypto.subtle.importKey(
  "pkcs8",
  privateKey.export({ type: "pkcs8", format: "der" }),
  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  true, // Fedify's signRequest insists on an extractable key
  ["sign"],
);

/** Inbox fixtures; every other actor uses its own /u/<name>/inbox. */
const FIXTURE_INBOXES: Record<string, string> = {
  loopback: "https://localhost:8443/inbox", // a name that resolves to 127.0.0.1
  privateip: "https://10.20.30.40/inbox", // RFC 1918 literal
  redirector: `${ORIGIN}/fixture/redirect`,
  flaky: `${ORIGIN}/fixture/flaky`, // fails `fail503` times, then accepts
  down: `${ORIGIN}/fixture/down`, // always 503
  refuser: `${ORIGIN}/fixture/refuse`, // always 400
  slow: `${ORIGIN}/fixture/slow`, // waits `slowMs` before the first answer
};

const mode = { fail503: 2, slowMs: 0 };
let received: { ts: string; path: string; status: number; body: unknown }[] = [];

function actorDocument(kind: "Person" | "Group", name: string) {
  const id = `${ORIGIN}/${kind === "Group" ? "c" : "u"}/${name}`;
  const inbox = FIXTURE_INBOXES[name] ?? `${id}/inbox`;
  return {
    "@context": [AS, "https://w3id.org/security/v1"],
    id,
    type: kind,
    preferredUsername: name,
    name: `rogue ${name}`,
    inbox,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    // Fixtures get no shared inbox, so their own inbox is the one used.
    ...(FIXTURE_INBOXES[name] ? {} : { endpoints: { sharedInbox: `${ORIGIN}/inbox` } }),
    ...(kind === "Group"
      ? { attributedTo: `${id}/moderators`, featured: `${id}/featured`, postingRestrictedToMods: false }
      : {}),
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem },
  };
}

async function deliver(as: string, inbox: string, activity: Record<string, unknown>) {
  const body = JSON.stringify({ "@context": AS, ...activity });
  const request = await signRequest(
    new Request(inbox, { method: "POST", headers: { "content-type": "application/activity+json" }, body }),
    signingKey,
    new URL(`${as}#main-key`),
    { spec: "draft-cavage-http-signatures-12" },
  );
  const response = await fetch(request);
  return { status: response.status, body: (await response.text()).slice(0, 500) };
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString()));
    req.on("end", () => resolve(text));
  });

const json = (res: ServerResponse, status: number, value: unknown, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(JSON.stringify(value));
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

async function onInbox(path: string, text: string, res: ServerResponse) {
  const body = parse(text);
  let status = 202;
  if (path === "/fixture/redirect") {
    received.push({ ts: new Date().toISOString(), path, status: 307, body });
    res.writeHead(307, { location: `${ORIGIN}/fixture/sink` });
    return res.end();
  }
  if (path === "/fixture/down") status = 503;
  if (path === "/fixture/refuse") status = 400;
  if (path === "/fixture/flaky" && mode.fail503 > 0) {
    mode.fail503 -= 1;
    status = 503;
  }
  if (path === "/fixture/slow" && mode.slowMs > 0) {
    const wait = mode.slowMs;
    mode.slowMs = 0; // only the first request is slow
    received.push({ ts: new Date().toISOString(), path: `${path} (started)`, status: 0, body });
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  received.push({ ts: new Date().toISOString(), path, status, body });
  res.writeHead(status).end();
  // Accept follows of the fake group, as a real server would.
  if (typeof body === "object" && body && "type" in body && body.type === "Follow" && "object" in body &&
      body.object === `${ORIGIN}/c/fake` && "id" in body && "actor" in body) {
    await deliver(`${ORIGIN}/c/fake`, FEDDIT_INBOX, {
      id: `${ORIGIN}/activities/accept/${randomUUID()}`,
      type: "Accept",
      actor: `${ORIGIN}/c/fake`,
      to: body.actor,
      object: { id: body.id, type: "Follow", actor: body.actor, object: body.object },
    }).then((result) => console.log("Accept sent:", result.status), (error: unknown) => console.log("Accept failed:", error));
  }
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", ORIGIN).pathname;
  const text = req.method === "POST" ? await readBody(req) : "";
  try {
    if (req.method === "GET") {
      const actor = /^\/(u|c)\/([a-z0-9]+)$/.exec(path);
      if (actor) return json(res, 200, actorDocument(actor[1] === "c" ? "Group" : "Person", actor[2]!), "application/activity+json");
      if (path === "/c/fake/moderators") {
        return json(res, 200, { "@context": AS, id: `${ORIGIN}/c/fake/moderators`, type: "OrderedCollection", orderedItems: [`${ORIGIN}/u/mallory`] }, "application/activity+json");
      }
      if (/^\/(u|c)\/[a-z0-9]+\/(outbox|followers|featured)$/.test(path)) {
        return json(res, 200, { "@context": AS, id: `${ORIGIN}${path}`, type: "OrderedCollection", totalItems: 0, orderedItems: [] }, "application/activity+json");
      }
      if (path === "/control/received") return json(res, 200, received);
      return json(res, 404, { error: "not found" });
    }
    if (path === "/control/send") {
      const { as, inbox, activity } = JSON.parse(text) as { as: string; inbox?: string; activity: Record<string, unknown> };
      return json(res, 200, await deliver(as, inbox ?? FEDDIT_INBOX, activity));
    }
    if (path === "/control/mode") {
      Object.assign(mode, JSON.parse(text));
      return json(res, 200, mode);
    }
    if (path === "/control/reset") {
      received = [];
      mode.fail503 = 2;
      mode.slowMs = 0;
      return json(res, 200, { ok: true });
    }
    return await onInbox(path, text, res);
  } catch (error) {
    return json(res, 500, { error: String(error) });
  }
}).listen(8000, "0.0.0.0", () => console.log("rogue listening on 8000"));
