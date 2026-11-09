// D1: the production delivery schedule, against rogue inboxes that misbehave on purpose, and a
// worker killed while it is POSTing. Three phases, because a runner cannot kill a container; the
// Makefile (`make interop-d1`) runs them around the kill:
//   before  fixtures follow !lab; one Announce meets every kind of inbox; a slow inbox holds a POST open
//   (the Makefile sends SIGKILL to peblish-worker)
//   mid     a post is made while no worker runs
//   (the Makefile starts the worker again)
//   after   the post made while the worker was down reaches the peers; the POST in flight at the kill
//           is sent again once its 60 s lease ran out; the fixtures unfollow
import { readFileSync, writeFileSync } from 'node:fs';
import type { Context } from '../context.ts';
import { RESULTS_DIR, sleep, waitFor } from '../lab.ts';
import { deliveryRows, expectDelivery, expectInbound } from '../match.ts';
import { peblish } from '../peblish.ts';
import { rogue } from '../rogue-client.ts';
import { postOnPeer, prepare } from './support.ts';

export type Phase = 'before' | 'mid' | 'after';

/** Fixture actors on the rogue (rogue.ts): their inboxes are the misbehaving ones. */
const FIXTURES = ['refuser', 'down', 'redirector', 'slow'] as const;
/** Fixtures whose inbox is a private or loopback address: peblish refuses to learn such an actor at all. */
const UNREACHABLE = ['privateip', 'loopback'] as const;
type Fixture = (typeof FIXTURES)[number];
const FIXTURE_INBOX: Record<Fixture | (typeof UNREACHABLE)[number], string> = {
  refuser: `${rogue.origin}/fixture/refuse`,
  down: `${rogue.origin}/fixture/down`,
  redirector: `${rogue.origin}/fixture/redirect`,
  privateip: 'https://10.20.30.40/inbox',
  loopback: 'https://localhost:8443/inbox',
  slow: `${rogue.origin}/fixture/slow`,
};

type State = { inFlight: { activity: string }; queued?: { title: string; apId: string } };
const STATE = `${RESULTS_DIR}/d1-state.json`;

export const SLOW_MS = 30_000;

const follow = (name: Fixture | (typeof UNREACHABLE)[number], ctx: Context) => ({
  id: `${rogue.origin}/activities/follow/${name}-${ctx.run}`,
  type: 'Follow',
  actor: rogue.actor(name),
  object: ctx.community.apId,
});

export async function durability(ctx: Context, phase: Phase): Promise<void> {
  const { rec, community } = ctx;
  const post = async (title: string) => {
    const created = await peblish.createPost('alice', community.id, { title, bodyMd: 'Delivery schedule.' });
    ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: created.apId });
    return created;
  };

  if (phase === 'before') {
    await rogue.reset();
    await rogue.mode({ fail503: 0, slowMs: 0 });
    // The fixtures follow !lab; their Accepts go through the same policy as everything else.
    for (const name of FIXTURES) {
      const started = new Date();
      const sent = await rogue.send(rogue.actor(name), follow(name, ctx));
      if (sent.status !== 202) throw new Error(`peblish answered the ${name} Follow ${sent.status}: ${sent.body}`);
      await expectInbound(ctx.sql, { since: started, actor: rogue.actor(name), type: 'Follow' }, { state: 'applied' });
    }
    await waitFor(
      'the Accepts to settle',
      async () => {
        const rows = await ctx.sql<{ state: string; inbox_url: string }[]>`
          select state, inbox_url from deliveries where activity_type = 'Accept' and created_at >= ${ctx.since}`;
        return rows.length >= FIXTURES.length && rows.every((r) => r.state !== 'pending' || r.inbox_url === FIXTURE_INBOX.down) && rows;
      },
      { timeoutMs: 60_000 },
    );
    for (const peer of ctx.peers) await prepare(ctx, peer);

    // One Announce meets every kind of inbox.
    const title = `D1 probe ${ctx.run}`;
    const started = new Date();
    const probe = await post(title);
    const row = (name: Fixture) => deliveryRows(ctx.sql, { since: started, type: 'Announce', inbox: FIXTURE_INBOX[name], contains: title });
    const settledOne = async (name: Fixture) =>
      waitFor(
        `the ${name} delivery to be tried`,
        async () => {
          const [first] = await row(name);
          // attempts counts at the claim; the outcome is recorded when the POST ends
          return first && first.attempts > 0 && (first.status !== null || first.error !== null || first.state !== 'pending')
            ? first
            : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 250 },
      );

    await rec.scenario('D1/refuser', 'peblish', async () => {
      const r = await settledOne('refuser');
      if (r.state !== 'failed' || r.attempts !== 1 || r.status !== 400) throw new Error(`got ${JSON.stringify(r)}`);
      return 'a 400 is final at attempt 1';
    });
    await rec.scenario('D1/down', 'peblish', async () => {
      const r = await settledOne('down');
      const [timing] = await ctx.sql<{ gap: number }[]>`
        select extract(epoch from next_attempt_at - created_at)::float as gap from deliveries where activity_ap_id = ${r.activityApId} and inbox_url = ${FIXTURE_INBOX.down}`;
      const gap = timing?.gap ?? 0;
      if (r.state !== 'pending' || r.status !== 503 || r.attempts !== 1) throw new Error(`got ${JSON.stringify(r)}`);
      if (gap < 10 || gap > 20) throw new Error(`the retry is ${gap.toFixed(1)} s after creation, expected 10 to 20 s`);
      return `a 503 is pending, retry ${gap.toFixed(1)} s after the delivery was created`;
    });
    await rec.scenario('D1/redirector', 'peblish', async () => {
      const r = await settledOne('redirector');
      if (r.state !== 'failed' || r.attempts !== 1 || r.status !== 307) throw new Error(`got ${JSON.stringify(r)}`);
      const sink = (await rogue.received()).filter((x) => x.path === '/fixture/sink');
      if (sink.length > 0) throw new Error('the redirect target received a POST');
      return 'a redirect is refused and not followed';
    });
    for (const name of UNREACHABLE) {
      await rec.scenario(`D1/${name}`, 'peblish', async () => {
        const sent = await rogue.send(rogue.actor(name), follow(name, ctx));
        if (sent.status !== 401 || !sent.body.includes('key_unknown')) throw new Error(`peblish answered ${sent.status}: ${sent.body}`);
        const [count] = await ctx.sql<{ n: number }[]>`select count(*)::int as n from deliveries where inbox_url = ${FIXTURE_INBOX[name]}`;
        if (count?.n) throw new Error(`${count.n} deliveries to ${FIXTURE_INBOX[name]}`);
        return `an actor whose inbox is ${FIXTURE_INBOX[name]} is refused at the door (401 key_unknown) and nothing is sent there`;
      });
    }
    await rec.scenario('D1/peers', 'peblish', async () => {
      for (const peer of ctx.peers) {
        await expectDelivery(
          ctx.sql,
          { since: started, type: 'Announce', host: new URL(peer.origin).host, contains: title },
          { state: 'delivered', attempts: 1 },
        );
      }
      return `the same Announce reached ${ctx.peers.map((p) => p.name).join(', ')} on the first attempt`;
    });
    void probe;

    // A POST held open at the slow inbox when the Makefile kills the worker.
    await rogue.mode({ slowMs: SLOW_MS });
    const inFlight = await post(`D1 in flight ${ctx.run}`);
    // The slow inbox gets more than one activity per post (the Announce of the Page and another); it holds
    // whichever arrives first, so follow the activity id of the request it holds.
    const held = await waitFor('the slow inbox to hold the request open', async () =>
      (await rogue.received()).find((x) => x.path === '/fixture/slow (started)' && JSON.stringify(x.body).includes(inFlight.apId)),
    );
    const activity = (held.body as { id?: string }).id;
    if (!activity) throw new Error('the held request has no activity id');
    writeFileSync(STATE, `${JSON.stringify({ inFlight: { activity } } satisfies State)}\n`);
    console.log('READY for SIGKILL: one delivery in flight');
    return;
  }

  const state = JSON.parse(readFileSync(STATE, 'utf8')) as State;
  if (phase === 'mid') {
    const queued = await post(`D1 queued ${ctx.run}`);
    writeFileSync(STATE, `${JSON.stringify({ ...state, queued: { title: `D1 queued ${ctx.run}`, apId: queued.apId } } satisfies State)}\n`);
    console.log('READY for the worker: one post made while it was down');
    return;
  }

  // after
  await rec.scenario('D1/queued', 'peblish', async () => {
    if (!state.queued) throw new Error('no queued post in the state file');
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);
      await postOnPeer(side, side.labOnPeer, state.queued.apId, { timeoutMs: 60_000 });
    }
    return `the post made while the worker was down reached ${ctx.peers.map((p) => p.name).join(', ')}`;
  });
  await rec.scenario('D1/lease', 'peblish', async () => {
    const r = await waitFor(
      'the in-flight delivery to be sent again after its lease',
      async () => {
        const [found] = await deliveryRows(ctx.sql, {
          since: new Date(0), // the row was made in the `before` phase
          type: 'Announce',
          inbox: FIXTURE_INBOX.slow,
          activity: state.inFlight.activity,
        });
        return found?.state === 'delivered' && found;
      },
      { timeoutMs: 150_000, intervalMs: 1_000 },
    );
    if (r.attempts < 2) throw new Error(`delivered after ${r.attempts} attempt`);
    return `in flight at SIGKILL, claimed again after the 60 s lease, delivered on attempt ${r.attempts}`;
  });

  // The `down` inbox never recovers: retire what is still queued for it, or the worker keeps retrying for 15 hours.
  await ctx.sql`update deliveries set state = 'failed', last_error = 'lab: fixture retired' where state = 'pending' and inbox_url = ${FIXTURE_INBOX.down}`;

  // Put the fixtures back: they unfollow, so later runs and the cleanup find !lab as it was.
  await rogue.mode({ fail503: 0, slowMs: 0 });
  for (const name of FIXTURES) {
    await rogue
      .send(rogue.actor(name), {
        id: `${rogue.origin}/activities/undo/${name}-${ctx.run}`,
        type: 'Undo',
        actor: rogue.actor(name),
        object: {
          id: `${rogue.origin}/activities/follow/${name}-${ctx.run}`,
          type: 'Follow',
          actor: rogue.actor(name),
          object: ctx.community.apId,
        },
      })
      .catch(() => undefined);
  }
  await sleep(500);
}
