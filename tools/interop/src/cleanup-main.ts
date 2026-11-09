// `node src/cleanup-main.ts [peers]`: runs cleanup (cleanup.ts) against the real lab.
import { cleanup, type LabPort } from './cleanup.ts';
import { RESULTS_DIR, sleep } from './lab.ts';
import { ledger, ledgerPath, open } from './ledger.ts';
import { closeAll, followRow, peblish, sql } from './peblish.ts';
import { selectPeers } from './peers/index.ts';
import type { Peer } from './peers/types.ts';
import type { Uuid } from '@peblish/schema/ids';

const q = () => sql();

export const realLab: LabPort = {
  async liveObject(type, apId) {
    const table = q()(type === 'post' ? 'posts' : 'comments');
    const [row] = await q()<{ id: string }[]>`select id from ${table} where ap_id = ${apId} and deleted_at is null`;
    return row?.id ?? null;
  },
  async deleteObject(user, type, id) {
    await (type === 'post' ? peblish.deletePost(user, id as Uuid) : peblish.deleteComment(user, id as Uuid));
  },
  async follow(user, handle) {
    const resolved = await peblish.resolve(handle);
    const row = await followRow(user, resolved.id as Uuid);
    return row ? { communityId: resolved.id, apId: row.apId } : null;
  },
  async unfollow(user, communityId) {
    await peblish.unfollow(user, communityId as Uuid);
  },
  async myVote(user, targetApId) {
    const [row] = await q()<{ value: -1 | 1 }[]>`
      select v.value from votes v join actors a on a.id = v.voter_id
      join posts p on p.id = v.post_id
      where a.local and a.name = ${user} and p.ap_id = ${targetApId}`;
    return row?.value ?? 0;
  },
  async clearVote(user, targetApId) {
    const [post] = await q()<{ id: Uuid }[]>`select id from posts where ap_id = ${targetApId}`;
    if (post) await peblish.vote(user, { kind: 'post', id: post.id }, 0);
  },
  async undoDelivered(object, inboxHost) {
    // The worker delivers on a 2 s tick, so give an Undo written a moment ago time to leave.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const rows = await q()<{ state: string }[]>`
        select state from deliveries where activity_type = 'Undo' and body like ${`%${object}%`} and inbox_url like ${`https://${inboxHost}/%`}`;
      if (rows.some((row) => row.state === 'delivered')) return true;
      if (Date.now() >= deadline) return false;
      await sleep(1_000);
    }
  },
};

const peers = selectPeers(process.argv.slice(2).filter((a) => !a.startsWith('--')));
const byName = Object.fromEntries(peers.map((peer) => [peer.name, peer] as const)) as Record<string, Peer>;
const store = ledger('cleanup');
const { cleaned, failures } = await cleanup(realLab, byName, { open: () => open(ledgerPath()), add: store.add, done: store.done });
await closeAll();
console.log(`${cleaned.length} cleaned, ${failures.length} failed (ledger ${RESULTS_DIR}/ledger.jsonl)`);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exitCode = failures.length > 0 ? 1 : 0;
