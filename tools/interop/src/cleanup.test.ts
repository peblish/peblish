import { describe, expect, it } from 'vitest';
import { cleanup, type Ledger, type LabPort } from './cleanup.ts';
import type { Entry } from './ledger.ts';
import type { Peer } from './peers/types.ts';

/** An in-memory ledger with the same open/add/done behavior as the file. */
function memoryLedger(entries: Entry[]): Ledger & { doneIds: number[]; all: Entry[] } {
  const all = [...entries];
  const doneIds: number[] = [];
  return {
    doneIds,
    all,
    open: () => all.flatMap((entry, index) => (doneIds.includes(index + 1) ? [] : [{ id: index + 1, run: 'r', entry }])),
    add(entry) {
      all.push(entry);
      return all.length;
    },
    done(id) {
      doneIds.push(id);
    },
  };
}

const lab = (overrides: Partial<LabPort> = {}): LabPort => ({
  liveObject: async () => null,
  deleteObject: async () => undefined,
  follow: async () => null,
  unfollow: async () => undefined,
  myVote: async () => 0,
  clearVote: async () => undefined,
  undoDelivered: async () => true,
  ...overrides,
});

/** A peer that records what cleanup asks of it; unlisted methods throw so a test sees an unexpected call. */
function fakePeer(calls: string[], overrides: Partial<Peer> = {}): Peer {
  return {
    name: 'lemmy',
    login: async (user: string) => `token-${user}`,
    ...overrides,
  } as unknown as Peer;
}

describe('cleanup', () => {
  it('(a) a retry still checks an Undo whose local follow row is already gone', async () => {
    const checked: string[] = [];
    const ledger = memoryLedger([
      { kind: 'follow', side: 'peblish', user: 'alice', community: '!lab@lemmy.lab.test' },
      // Written by the first invocation, which stopped before it could check.
      { kind: 'undo', activityType: 'Undo', object: 'https://peblish.lab.test/follow/1', inboxHost: 'lemmy.lab.test' },
    ]);
    const result = await cleanup(
      lab({
        follow: async () => null,
        undoDelivered: async (object, host) => {
          checked.push(`${object} ${host}`);
          return true;
        },
      }),
      {},
      ledger,
    );
    expect(checked).toEqual(['https://peblish.lab.test/follow/1 lemmy.lab.test']);
    expect(result.failures).toEqual([]);
    expect(ledger.open()).toEqual([]);
  });

  it('(a) an Undo that was not delivered stays open and is a failure', async () => {
    const ledger = memoryLedger([{ kind: 'undo', activityType: 'Undo', object: 'follow-1', inboxHost: 'lemmy.lab.test' }]);
    const result = await cleanup(lab({ undoDelivered: async () => false }), {}, ledger);
    expect(result.failures).toHaveLength(1);
    expect(ledger.open()).toHaveLength(1);
  });

  it('(b) clears a peer vote that peblish never recorded, found from my_vote', async () => {
    const calls: string[] = [];
    let vote: -1 | 0 | 1 = 1;
    const peer = fakePeer(calls, {
      myPostVote: async () => vote,
      votePost: async (_token: string, postId: number, score: -1 | 0 | 1) => {
        calls.push(`vote ${postId} ${score}`);
        vote = score;
      },
    });
    const ledger = memoryLedger([
      { kind: 'vote', side: 'lemmy', user: 'lemmyuser', target: 'https://peblish.lab.test/p/1', targetType: 'post', peerId: 7 },
    ]);
    // peblish's own votes table says nothing: its myVote is 0 and must not decide.
    const result = await cleanup(lab({ myVote: async () => 0 }), { lemmy: peer }, ledger);
    expect(calls).toEqual(['vote 7 0']);
    expect(result.failures).toEqual([]);
  });

  it('(b) leaves a vote alone when the peer shows none', async () => {
    const calls: string[] = [];
    const peer = fakePeer(calls, { myPostVote: async () => 0, votePost: async () => void calls.push('vote') });
    const ledger = memoryLedger([{ kind: 'vote', side: 'lemmy', user: 'lemmyuser', target: 't', targetType: 'post', peerId: 7 }]);
    await cleanup(lab(), { lemmy: peer }, ledger);
    expect(calls).toEqual([]);
  });

  it('(c) resolves an object without a peer id by ap_id and deletes it', async () => {
    const calls: string[] = [];
    const peer = fakePeer(calls, {
      resolvePost: async (_token: string, apId: string) => (apId === 'https://lemmy.lab.test/post/9' ? ({ id: 9 } as never) : null),
      deletePost: async (_token: string, id: number) => void calls.push(`delete ${id}`),
    });
    const ledger = memoryLedger([
      { kind: 'object', side: 'lemmy', user: 'lemmyuser', type: 'post', apId: 'https://lemmy.lab.test/post/9' },
    ]);
    const result = await cleanup(lab(), { lemmy: peer }, ledger);
    expect(calls).toEqual(['delete 9']);
    expect(result.failures).toEqual([]);
  });

  it('(c) failing to resolve is a failure and the entry stays open', async () => {
    const peer = fakePeer([], { resolvePost: async () => null, deletePost: async () => undefined });
    const ledger = memoryLedger([
      { kind: 'object', side: 'lemmy', user: 'lemmyuser', type: 'post', apId: 'https://lemmy.lab.test/post/9' },
    ]);
    const result = await cleanup(lab(), { lemmy: peer }, ledger);
    expect(result.failures).toEqual([expect.stringContaining('cannot resolve https://lemmy.lab.test/post/9')]);
    expect(ledger.open()).toHaveLength(1);
  });

  it('unfollowing on peblish writes the Undo it owes before checking it', async () => {
    const ledger = memoryLedger([{ kind: 'follow', side: 'peblish', user: 'alice', community: '!lab@lemmy.lab.test' }]);
    const checked: string[] = [];
    const result = await cleanup(
      lab({
        follow: async () => ({ communityId: 'c1', apId: 'follow-1' }),
        undoDelivered: async (object) => {
          checked.push(object);
          return true;
        },
      }),
      {},
      ledger,
    );
    expect(checked).toEqual(['follow-1']);
    expect(result.failures).toEqual([]);
  });
});
