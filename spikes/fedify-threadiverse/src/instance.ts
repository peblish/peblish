// The instance actor: an Application at the site root, which is where Lemmy
// (ApubSite) and PieFed look for a server's own actor. Fedify's actor
// dispatcher needs an {identifier} in its path, so this one is served by
// routes.ts. Its name matches NodeInfo's nodeName, its inbox is the shared
// inbox, and its key is stored like any actor's (identifier "instance").
import { Application, CryptographicKey, Endpoints } from "@fedify/vocab";
import type { Context } from "@fedify/fedify";
import { NODE_NAME, ORIGIN } from "./config.ts";
import { toInstant } from "./content.ts";
import { sql } from "./db.ts";
import { loadOrCreateKeyPair } from "./federation.ts";

export const INSTANCE_ID = new URL("/", ORIGIN);
export const INSTANCE_KEY_ID = new URL("/#main-key", ORIGIN);

export async function instanceActor(ctx: Context<void>): Promise<Application> {
  const { publicKey } = await loadOrCreateKeyPair("instance", "RSASSA-PKCS1-v1_5");
  // Stable across restarts: the instance is as old as its first actor.
  const [row] = await sql<{ first: Date }[]>`select coalesce(min(created_at), now()) as first from actors`;
  return new Application({
    id: INSTANCE_ID,
    preferredUsername: ORIGIN.hostname,
    name: NODE_NAME,
    summary: "Fedify threadiverse spike, local lab instance.",
    url: INSTANCE_ID,
    inbox: ctx.getInboxUri(),
    outbox: new URL("/outbox", ORIGIN),
    endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
    publicKey: new CryptographicKey({ id: INSTANCE_KEY_ID, owner: INSTANCE_ID, publicKey }),
    published: toInstant(row!.first),
    manuallyApprovesFollowers: true,
  });
}
