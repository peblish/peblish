// `make seed`: users and one community on every peer, and peblish's accounts. Idempotent.
// The peblish admin is created before this runs, by the image's own `admin.mjs` (the Makefile),
// which proves the image can bootstrap itself; PieFed's users by lab/piefed/bootstrap.py (it
// has no register API). Mbin's by its console (lab/mbin/seed.sh).
import { seedAccount, seedTwoFactor } from '@peblish/core/testing/seed-a';
import type { Uuid } from '@peblish/schema/ids';
import { HttpError, http, LEMMY, PASSWORD, PEBLISH, PIEFED, sleep, waitFor } from './lab.ts';
import { closeAll, forget, localActorId, peblish, sql } from './peblish.ts';
import { lemmy, piefed } from './peers/threadiverse.ts';

const ready = (url: string) => async () => {
  await http('GET', url);
  return true;
};

console.log('waiting for peers...');
await Promise.all([
  waitFor('Lemmy API', ready(`${LEMMY}/api/v3/site`), { timeoutMs: 240_000, intervalMs: 2_000 }),
  waitFor('PieFed API', ready(`${PIEFED}/api/alpha/site`), { timeoutMs: 240_000, intervalMs: 2_000 }),
  waitFor('peblish', ready(`${PEBLISH}/nodeinfo/2.1`), { timeoutMs: 240_000, intervalMs: 2_000 }),
]);

async function ignoreExisting(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    console.log(`created ${label}`);
  } catch (error) {
    if (error instanceof HttpError && /exist|taken|already/i.test(error.body)) console.log(`${label} already exists`);
    else throw error;
  }
}

// ---------------------------------------------------------------- Lemmy 0.19.21

// Generous limits: every scenario request comes from the runner's one IP.
const rateLimits = Object.fromEntries(
  ['message', 'post', 'register', 'image', 'comment', 'search'].flatMap((name) => [
    [`rate_limit_${name}`, 10_000],
    [`rate_limit_${name}_per_second`, 60],
  ]),
);

/**
 * Registers (or logs in) a Lemmy user and returns a JWT. Lemmy derives the JWT from a
 * second-resolution `iat`, so a login in the same second as the registration collides on
 * login_token_pkey; reuse the register token instead.
 */
async function lemmyToken(username: string): Promise<string> {
  try {
    const { jwt } = await http<{ jwt?: string }>('POST', `${LEMMY}/api/v3/user/register`, {
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
const site = await http<{ site_view: { local_site: { site_setup: boolean } } }>('GET', `${LEMMY}/api/v3/site`);
if (!site.site_view.local_site.site_setup) {
  await http('POST', `${LEMMY}/api/v3/site`, {
    token: lemmyAdmin,
    body: {
      name: 'Lemmy lab',
      registration_mode: 'Open',
      require_email_verification: false,
      captcha_enabled: false,
      federation_enabled: true,
      enable_downvotes: true,
      ...rateLimits,
    },
  });
  console.log('created Lemmy site');
}
// The allowlist is only settable through EditSite in 0.19. The rogue is on no list.
await http('PUT', `${LEMMY}/api/v3/site`, {
  token: lemmyAdmin,
  body: { allowed_instances: ['peblish.lab.test', 'piefed.lab.test', 'mbin.lab.test'], ...rateLimits },
});
await lemmyToken(lemmy.user);
await ignoreExisting('Lemmy community !lab', () => lemmy.createCommunity(lemmyAdmin, lemmy.community, 'Lemmy lab'));

// ---------------------------------------------------------------- PieFed 1.8.11

const pieAdmin = await piefed.login(piefed.admin);
await ignoreExisting('PieFed community !pflab', () => piefed.createCommunity(pieAdmin, piefed.community, 'PieFed lab'));

// ---------------------------------------------------------------- peblish (the production image)

const [admin] = await sql()<{ user_id: string | null }[]>`select user_id from actors where local and kind = 'Person' and name = 'labadmin'`;
if (!admin?.user_id) throw new Error('the peblish admin labadmin does not exist; run make seed, which creates it with admin.mjs first');
await seedTwoFactor(admin.user_id as Uuid);
forget('labadmin');
for (const name of ['alice', 'bob']) {
  const exists = await sql()`select 1 from actors where local and kind = 'Person' and name = ${name}`;
  if (exists.length === 0) {
    await seedAccount(name, { password: PASSWORD });
    console.log(`created peblish user ${name}`);
  }
}
const exists = await sql()`select 1 from actors where local and kind = 'Group' and name = 'lab'`;
if (exists.length === 0) {
  await peblish.createCommunity('labadmin', 'lab', 'peblish lab', 'The community the peers follow.');
  console.log('created peblish community !lab');
}
console.log(`peblish !lab is ${await localActorId('Group', 'lab')}`);

// Lemmy (release build) starts its outbound worker for a newly seen instance on a 60 s timer,
// and that worker skips every activity queued before it started. Wait for the lab peers' workers
// so the first Follow is not lost (lab/Makefile also waits on federation_queue_state).
await closeAll();
console.log('seed done');
