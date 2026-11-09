// H1: what peblish serves and how it speaks: WebFinger by name and by URL, NodeInfo, 410
// Tombstones for what is gone, a delivery to an inbox URL with a query, and the signed GET.
import type { Group } from '../context.ts';
import { http, HttpError, PEBLISH, waitFor } from '../lab.ts';
import { expectDelivery } from '../match.ts';
import { peblish } from '../peblish.ts';
import { rogue } from '../rogue-client.ts';
import { tag } from './support.ts';

const ACTIVITY = 'application/activity+json';
const get = async (url: string, accept = ACTIVITY) => {
  const response = await fetch(url, { headers: { accept }, redirect: 'manual' });
  return { status: response.status, body: await response.text(), type: response.headers.get('content-type') ?? '' };
};

export const protocol: Group = {
  ids: ['H1'],
  async run(ctx) {
    const { rec, community } = ctx;

    await rec.scenario('H1/webfinger', 'peblish', async () => {
      const byName = await http<{ subject: string; links: { rel: string; href?: string; type?: string }[] }>(
        'GET',
        `${PEBLISH}/.well-known/webfinger`,
        {
          query: { resource: 'acct:lab@peblish.lab.test' },
        },
      );
      const self = byName.links.find((l) => l.rel === 'self');
      if (self?.href !== community.apId) throw new Error(`self link ${self?.href}, expected ${community.apId}`);
      const byUrl = await http<{ links: { rel: string; href?: string }[] }>('GET', `${PEBLISH}/.well-known/webfinger`, {
        query: { resource: community.apId },
      });
      if (byUrl.links.find((l) => l.rel === 'self')?.href !== community.apId)
        throw new Error('a WebFinger lookup by URL did not answer with the same actor');
      const missing = await get(`${PEBLISH}/.well-known/webfinger?resource=acct:nobody@peblish.lab.test`, 'application/jrd+json');
      if (missing.status !== 404) throw new Error(`an unknown account answered ${missing.status}`);
      return 'by name and by URL; an unknown account is 404';
    });

    await rec.scenario('H1/nodeinfo', 'peblish', async () => {
      const index = await http<{ links: { rel: string; href: string }[] }>('GET', `${PEBLISH}/.well-known/nodeinfo`);
      const rels = index.links.map((l) => l.rel.split('/').at(-1));
      if (!rels.includes('2.0') || !rels.includes('2.1')) throw new Error(`NodeInfo schemas ${rels.join(', ')}`);
      const info = await http<{ software: { name: string }; protocols: string[] }>('GET', `${PEBLISH}/nodeinfo/2.1`);
      if (info.software.name !== 'peblish' || !info.protocols.includes('activitypub')) throw new Error(JSON.stringify(info.software));
      return `software ${info.software.name}, activitypub`;
    });

    await rec.scenario('H1/tombstones', 'peblish', async () => {
      const post = await peblish.createPost('alice', community.id, {
        title: tag(ctx, 'H1', { name: 'peblish' }),
        bodyMd: 'To be deleted.',
      });
      ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: post.apId });
      const alive = await get(post.apId);
      if (alive.status !== 200) throw new Error(`a live post answered ${alive.status}`);
      await peblish.deletePost('alice', post.id);
      const gone = await waitFor('the deleted post to answer 410', async () => {
        const r = await get(post.apId);
        return r.status === 410 && r;
      });
      if (!gone.body.includes('Tombstone')) throw new Error(`410 without a Tombstone: ${gone.body.slice(0, 120)}`);
      return 'live 200, deleted 410 with a Tombstone';
    });

    await rec.scenario('H1/query-inbox', 'rogue', async () => {
      // The rogue follows as an actor whose inbox URL has a query string; peblish must sign and deliver to it.
      const queried = rogue.actor('queried');
      await rogue.reset();
      const started = new Date();
      const follow = { id: `${rogue.origin}/activities/follow/query-${ctx.run}`, type: 'Follow', actor: queried, object: community.apId };
      const sent = await rogue.send(queried, follow);
      if (sent.status !== 202) throw new Error(`peblish answered the Follow ${sent.status}`);
      const accept = await expectDelivery(ctx.sql, { since: started, type: 'Accept', host: 'rogue.lab.test' }, { state: 'delivered' });
      if (!accept.inbox.includes('?a=1&b=2')) throw new Error(`delivered to ${accept.inbox}, the query is missing`);
      const got = (await rogue.received()).find((r) => r.path.includes('?a=1&b=2'));
      if (!got) throw new Error('the rogue never saw the query string');
      return `Accept delivered to ${accept.inbox}`;
    });

    await rec.scenario('H1/signed-get', 'rogue', async () => {
      // peblish fetches an actor with a signed GET; the rogue records the Signature header.
      await rogue.reset();
      await peblish.resolve(rogue.actor('mallory'), { refresh: true });
      const signed = await waitFor('a signed GET at the rogue', async () =>
        (await rogue.gets()).find((g) => g.path.startsWith('/u/mallory') && g.signed),
      );
      if (!signed.headers?.includes('keyId')) throw new Error(`Signature header ${signed.headers}`);
      return 'GET /u/mallory carried a Signature header';
    });
    void HttpError;
  },
};
