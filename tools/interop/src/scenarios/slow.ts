// F3, the slow tier (`make interop-slow`): a Follow nobody answers is sent again 5 and 15 minutes
// after the first send, each time under a fresh id. The rogue's group `silent` never accepts.
import type { Group } from '../context.ts';
import { waitFor } from '../lab.ts';
import { peblish } from '../peblish.ts';
import { rogue } from '../rogue-client.ts';

export const resend: Group = {
  ids: ['F3'],
  async run(ctx) {
    if (!ctx.slow) return;
    const silent = rogue.group('silent');
    await ctx.rec.scenario('F3', 'rogue', async () => {
      await rogue.reset();
      const handle = silent;
      ctx.ledger.add({ kind: 'follow', side: 'peblish', user: 'alice', community: handle });
      const started = Date.now();
      await peblish.followRemote('alice', handle);
      const follows = async () =>
        (await rogue.received()).flatMap((r) => {
          const body = r.body as { type?: string; id?: string; object?: string };
          return body.type === 'Follow' && body.object === silent && body.id ? [{ id: body.id, at: Date.parse(r.ts) }] : [];
        });
      const sends = await waitFor('the third send of the Follow', async () => (await follows()).length >= 3 && (await follows()), {
        timeoutMs: 17 * 60_000,
        intervalMs: 10_000,
      });
      const ids = new Set(sends.map((s) => s.id));
      if (ids.size !== sends.length) throw new Error('a resend reused the Follow id');
      const minutes = sends.map((s) => Math.round(((s.at - started) / 60_000) * 10) / 10);
      return `the Follow went out at ${minutes.join(', ')} minutes, each under its own id`;
    });
  },
};
