// `make cleanup`: puts the lab back after a run, from the ledger (ledger.ts). It deletes what
// scenarios created, unfollows, clears votes and checks that each Undo(Follow) peblish owed was
// delivered. Three rules keep it from reporting a clean lab that is not:
//   a. every open Undo in the ledger is re-checked on every invocation, not just the ones this
//      invocation created: a retry finds the local follow row already gone and still has to
//      confirm that the Undo arrived;
//   b. a vote to clear is found from what the peer says (`my_vote`) over the ledger's targets,
//      because peblish's `votes` has no row for a Like the peer accepted and peblish never saw;
//   c. an object without a peer id is looked up by `ap_id`, and a lookup that finds nothing is a
//      failure, not a skipped check.
// The module takes its collaborators as arguments, so the unit test runs with fakes and no lab.
import type { Entry } from './ledger.ts';
import type { Peer, PeerName } from './peers/types.ts';

/** What cleanup needs from peblish; `realLab` in cleanup-main.ts implements it over the database. */
export type LabPort = {
  /** The live post or comment row with this `ap_id`, or null when it is gone or deleted. */
  liveObject(type: 'post' | 'comment', apId: string): Promise<string | null>;
  deleteObject(user: string, type: 'post' | 'comment', id: string): Promise<void>;
  /** The user's follow of a remote community (`!name@host`): its row id (to unfollow) and Follow activity id. */
  follow(user: string, handle: string): Promise<{ communityId: string; apId: string | null } | null>;
  unfollow(user: string, communityId: string): Promise<void>;
  /** The user's current vote on a post of peblish's, 0 when none. */
  myVote(user: string, targetApId: string): Promise<-1 | 0 | 1>;
  clearVote(user: string, targetApId: string): Promise<void>;
  /** Whether an `Undo` delivery about `object` to a host settled as delivered. */
  undoDelivered(object: string, inboxHost: string): Promise<boolean>;
};

export type Ledger = {
  open(): { id: number; run: string; entry: Entry }[];
  add(entry: Entry): number;
  done(id: number, note?: string): void;
};

export type CleanupResult = { cleaned: string[]; failures: string[] };

const hostOf = (handle: string) => handle.slice(handle.lastIndexOf('@') + 1);

export async function cleanup(lab: LabPort, peers: Partial<Record<PeerName, Peer>>, ledger: Ledger): Promise<CleanupResult> {
  const result: CleanupResult = { cleaned: [], failures: [] };
  const ok = (id: number, note: string) => {
    ledger.done(id, note);
    result.cleaned.push(note);
  };
  const fail = (note: string) => result.failures.push(note);
  const peerOf = (side: PeerName) => {
    const peer = peers[side];
    if (!peer) throw new Error(`${side} is not among the peers of this invocation`);
    return peer;
  };

  /** Runs one entry; whatever it throws is that entry's failure and the others carry on. */
  const attempt = async (id: number, label: string, run: () => Promise<string>) => {
    try {
      ok(id, await run());
    } catch (error) {
      fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Votes first, while the objects they refer to still exist, then objects (comments before posts), then follows.
  const entries = ledger.open();

  for (const { id, entry } of entries) {
    if (entry.kind !== 'vote') continue;
    await attempt(id, `vote by ${entry.user} on ${entry.target}`, async () => {
      if (entry.side === 'peblish') {
        if ((await lab.myVote(entry.user, entry.target)) !== 0) await lab.clearVote(entry.user, entry.target);
        return `cleared ${entry.user}'s vote on ${entry.target}`;
      }
      if (entry.targetType !== 'post') throw new Error('only votes on posts can be read back from a peer');
      const peer = peerOf(entry.side);
      const token = await peer.login(entry.user);
      const postId = entry.peerId ?? (await peer.resolvePost(token, entry.target))?.id;
      if (postId === undefined) throw new Error(`${peer.name} does not know ${entry.target}`);
      if ((await peer.myPostVote(token, postId)) !== 0) {
        await peer.votePost(token, postId, 0);
        if ((await peer.myPostVote(token, postId)) !== 0) throw new Error(`${peer.name} still shows the vote`);
      }
      return `cleared ${entry.user}'s vote on ${entry.target} on ${peer.name}`;
    });
  }

  const objects = entries.flatMap(({ id, entry }) => (entry.kind === 'object' ? [{ id, entry }] : []));
  objects.sort((a, b) => Number(b.entry.type === 'comment') - Number(a.entry.type === 'comment'));
  for (const { id, entry } of objects) {
    await attempt(id, `${entry.type} ${entry.apId}`, async () => {
      if (entry.side === 'peblish') {
        const live = await lab.liveObject(entry.type, entry.apId);
        if (live) await lab.deleteObject(entry.user, entry.type, live);
        return `${entry.type} ${entry.apId} gone from peblish`;
      }
      const peer = peerOf(entry.side);
      const token = await peer.login(entry.user);
      let peerId = entry.peerId;
      if (peerId === undefined) {
        if (entry.type !== 'post') throw new Error(`${entry.apId} has no ${peer.name} id and a comment cannot be looked up by ap_id`);
        const found = await peer.resolvePost(token, entry.apId);
        if (!found) throw new Error(`${peer.name} cannot resolve ${entry.apId}`);
        peerId = found.id;
      }
      await (entry.type === 'post' ? peer.deletePost(token, peerId) : peer.deleteComment(token, peerId));
      return `${entry.type} ${entry.apId} deleted on ${peer.name}`;
    });
  }

  for (const { id, entry } of entries) {
    if (entry.kind !== 'follow') continue;
    await attempt(id, `follow by ${entry.user} of ${entry.community}`, async () => {
      if (entry.side === 'peblish') {
        // The local row goes first; the Undo it owes is written to the ledger before anything can fail.
        const row = await lab.follow(entry.user, entry.community);
        if (row) {
          await lab.unfollow(entry.user, row.communityId);
          if (row.apId) ledger.add({ kind: 'undo', activityType: 'Undo', object: row.apId, inboxHost: hostOf(entry.community) });
        }
        return `${entry.user} no longer follows ${entry.community}`;
      }
      const peer = peerOf(entry.side);
      const token = await peer.login(entry.user);
      const community = await peer.resolveCommunity(token, entry.community);
      if (community.subscribed !== 'NotSubscribed') await peer.unfollow(token, community.id);
      return `${entry.user} unfollowed ${entry.community} on ${peer.name}`;
    });
  }

  // Every open Undo, whichever invocation wrote it (rule a): the entries added just above are in the ledger now.
  for (const { id, entry } of ledger.open()) {
    if (entry.kind !== 'undo') continue;
    await attempt(id, `Undo of ${entry.object} to ${entry.inboxHost}`, async () => {
      if (!(await lab.undoDelivered(entry.object, entry.inboxHost))) throw new Error('no delivered Undo');
      return `Undo of ${entry.object} delivered to ${entry.inboxHost}`;
    });
  }
  return result;
}
