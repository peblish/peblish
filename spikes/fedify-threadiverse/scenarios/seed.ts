// `make seed`: admins, users and one community per server. Idempotent.
// PieFed users are created by lab/piefed/bootstrap.py first (no register API).
import { FEDDIT, feddit, HttpError, http, LEMMY, lemmy, PASSWORD, PIEFED, piefed, sleep, waitFor } from "./lib.ts";

const ready = (url: string) => async () => {
  await http("GET", url);
  return true;
};

console.log("waiting for peers...");
await waitFor("Lemmy API", ready(`${LEMMY}/api/v3/site`), { timeoutMs: 240_000, intervalMs: 2_000 });
await waitFor("PieFed API", ready(`${PIEFED}/api/alpha/site`), { timeoutMs: 240_000, intervalMs: 2_000 });
await waitFor("Feddit", ready(`${FEDDIT}/nodeinfo/2.1`), { timeoutMs: 240_000, intervalMs: 2_000 });

async function ignoreExisting(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    console.log(`created ${label}`);
  } catch (error) {
    if (error instanceof HttpError && /exist|taken|already/i.test(error.body)) {
      console.log(`${label} already exists`);
    } else {
      throw error;
    }
  }
}

// ---------------------------------------------------------------- Lemmy 0.19.21

// Generous limits: every scenario request comes from the runner's one IP.
const rateLimits = Object.fromEntries(
  ["message", "post", "register", "image", "comment", "search"].flatMap((name) => [
    [`rate_limit_${name}`, 10_000],
    [`rate_limit_${name}_per_second`, 60],
  ]),
);

/**
 * Registers (or logs in) a Lemmy user and returns a JWT. Lemmy derives the JWT
 * from a second-resolution `iat`, so a login in the same second as the
 * registration collides on login_token_pkey; reuse the register token instead.
 */
async function lemmyToken(username: string): Promise<string> {
  try {
    const { jwt } = await http<{ jwt?: string }>("POST", `${LEMMY}/api/v3/user/register`, {
      body: { username, password: PASSWORD, password_verify: PASSWORD, show_nsfw: false },
    });
    if (jwt) {
      console.log(`registered Lemmy user ${username}`);
      return jwt;
    }
  } catch (error) {
    if (!(error instanceof HttpError && /exist|taken/i.test(error.body))) throw error;
  }
  await sleep(1_100);
  return await lemmy.login(username);
}

// First-run API: the first registered user becomes admin, then CreateSite.
const lemmyAdmin = await lemmyToken(lemmy.admin);
const site = await http<{ site_view: { local_site: { site_setup: boolean } } }>("GET", `${LEMMY}/api/v3/site`);
if (!site.site_view.local_site.site_setup) {
  await http("POST", `${LEMMY}/api/v3/site`, {
    token: lemmyAdmin,
    body: {
      name: "Lemmy lab",
      registration_mode: "Open",
      require_email_verification: false,
      captcha_enabled: false,
      federation_enabled: true,
      enable_downvotes: true,
      ...rateLimits,
    },
  });
  console.log("created Lemmy site");
}
// The allowlist is only settable through EditSite in 0.19.
await http("PUT", `${LEMMY}/api/v3/site`, {
  token: lemmyAdmin,
  body: { allowed_instances: ["feddit.lab.test", "piefed.lab.test"], ...rateLimits },
});
await lemmyToken(lemmy.user);
await ignoreExisting("Lemmy community !lab", () => lemmy.createCommunity(lemmyAdmin, "lab", "Lemmy lab"));

// ---------------------------------------------------------------- PieFed 1.8.11

const pieAdmin = await piefed.login(piefed.admin);
await ignoreExisting("PieFed community !pflab", () => piefed.createCommunity(pieAdmin, "pflab", "PieFed lab"));

// ---------------------------------------------------------------- Feddit (Fedify spike)

await feddit.call("actors", { kind: "Person", name: "alice", displayName: "Alice (Feddit)" });
await feddit.call("actors", { kind: "Person", name: "bob", displayName: "Bob (Feddit)" });
await feddit.call("actors", {
  kind: "Group",
  name: "spike",
  displayName: "Feddit spike",
  summary: "Test community for the **Fedify** threadiverse interop spike.",
  moderators: ["alice"],
});
console.log("created Feddit users alice, bob and community !spike");
console.log("seed done");
