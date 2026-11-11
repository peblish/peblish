// The feddit-admin name check (cutover step 8; plan: "check before B06 whether Lemmy resolves
// and accepts activities from feddit-admin (hyphenated)"). Runs in the federation lab's runner
// container, which has tools/interop's dependencies only, so it imports nothing but node builtins
// and the runner's own helpers (by relative path, resolved inside the image as in the repo):
//
//   cd lab && docker compose run --rm runner node ../cutover/src/lab/name-check.ts
//
// A local peblish account named feddit-admin, written the way the cutover import writes one
// (imported_at set, so the hyphen passes actors_local_name_chars), follows !lab@lemmy.lab.test,
// posts there, and a Lemmy user replies mentioning it. It records what Lemmy 0.19.21 did with each
// step and prints one JSON result; it exits 1 when the follow or the post did not reach Lemmy.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { HttpError, http, LEMMY, PEBLISH, runId, waitFor } from '../../../interop/src/lab.ts';
import { closeAll, followRow, peblish, sql } from '../../../interop/src/peblish.ts';
import { lemmy } from '../../../interop/src/peers/threadiverse.ts';

const NAME = 'feddit-admin';
const apId = `${PEBLISH}/u/${NAME}`;
const outcome = (step: string, value: unknown) => console.log(`${step}: ${JSON.stringify(value)}`);

async function ensureImportedAccount(): Promise<void> {
  const db = sql();
  if ((await db`select 1 from actors where ap_id = ${apId}`).length > 0) return;
  const [instance] = await db<{ id: string; origin: string }[]>`select id, origin from instances where local`;
  if (!instance) throw new Error('the lab peblish has no local instance');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const userId = randomUUID();
  const actorId = randomUUID();
  await db.begin(async (q) => {
    // Email verified: an unverified account cannot post (authz/roles.ts emailUnverified).
    await q`insert into auth_user (id, name, email, email_verified, role, two_factor_enabled)
      values (${userId}, ${NAME}, ${`${NAME}@peblish.lab.test`}, true, 'user', false)`;
    await q`insert into actors (id, ap_id, kind, local, instance_id, name, inbox_url, shared_inbox_url, outbox_url, followers_url, user_id, imported_at, published_at)
      values (${actorId}, ${apId}, 'Person', true, ${instance.id}, ${NAME}, ${`${apId}/inbox`}, ${`${instance.origin}/inbox`},
        ${`${apId}/outbox`}, ${`${apId}/followers`}, ${userId}, now(), now())`;
    await q`insert into actor_keys (id, actor_id, key_id, algorithm, public_key_pem, private_key_pem)
      values (${randomUUID()}, ${actorId}, ${`${apId}#main-key`}, 'rsa', ${publicKey}, ${privateKey})`;
  });
}

async function resolveOnLemmy(token: string, q: string): Promise<string> {
  try {
    const found = await http<{ person?: { person: { name: string; actor_id: string } } }>('GET', `${LEMMY}/api/v3/resolve_object`, {
      token,
      query: { q },
    });
    return found.person ? `resolved ${found.person.person.name} ${found.person.person.actor_id}` : 'no person';
  } catch (error) {
    return error instanceof HttpError ? `refused ${error.status}: ${error.body.slice(0, 200)}` : String(error);
  }
}

let failed = false;
try {
  await ensureImportedAccount();
  outcome('peblish account', { apId, name: NAME });

  const followed = await peblish.followRemote(NAME, lemmy.communityHandle());
  const accepted = await waitFor(
    'the Accept from Lemmy',
    async () => (await followRow(NAME, followed.communityId))?.state === 'accepted',
    { timeoutMs: 180_000, intervalMs: 2_000 },
  ).catch((error: unknown) => String(error));
  outcome('follow !lab@lemmy.lab.test', accepted === true ? 'accepted' : accepted);
  if (accepted !== true) failed = true;

  const title = `feddit-admin name check ${runId()}`;
  const post = await peblish.createPost(NAME, followed.communityId, { title, bodyMd: 'Posted by a hyphenated local name.' });
  const token = await lemmy.login(lemmy.user);
  const community = await lemmy.resolveCommunity(token, lemmy.communityHandle());
  const seen = await waitFor(
    'the post on Lemmy',
    async () => (await lemmy.listPosts(token, community.id)).find((row) => row.apId === post.apId),
    { timeoutMs: 180_000, intervalMs: 2_000 },
  ).catch((error: unknown) => String(error));
  if (typeof seen === 'string') {
    failed = true;
    outcome('post on Lemmy', seen);
  } else {
    outcome('post on Lemmy', { apId: seen.apId, creator: seen.creatorApId });
    // A Lemmy reply that mentions the account: does Lemmy tag the hyphenated name?
    const reply = await lemmy.comment(token, seen.id, null, `Reply to @${NAME}@peblish.lab.test from Lemmy.`);
    const arrived = await waitFor(
      'the reply in peblish',
      async () => (await sql()<{ raw: { tag?: unknown } | null }[]>`select raw from comments where ap_id = ${reply.apId}`)[0],
      { timeoutMs: 120_000, intervalMs: 2_000 },
    ).catch((error: unknown) => String(error));
    const tags = typeof arrived === 'string' ? arrived : (arrived.raw?.tag ?? []);
    outcome('Lemmy reply mentioning the name', { arrived: typeof arrived !== 'string', tags });
  }

  outcome('Lemmy resolves the actor URL', await resolveOnLemmy(token, apId));
  outcome('Lemmy resolves the handle', await resolveOnLemmy(token, `@${NAME}@peblish.lab.test`));
  const [person] = await http<{ person_view?: { person: { name: string; actor_id: string; local: boolean } } }>(
    'GET',
    `${LEMMY}/api/v3/user`,
    { token, query: { username: `${NAME}@peblish.lab.test` } },
  )
    .then((found) => [found.person_view?.person ?? null])
    .catch((error: unknown) => [error instanceof HttpError ? `refused ${error.status}: ${error.body.slice(0, 200)}` : String(error)]);
  outcome('Lemmy user page lookup by name', person);
} finally {
  await closeAll();
}
process.exitCode = failed ? 1 : 0;
