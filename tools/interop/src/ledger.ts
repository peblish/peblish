// The cleanup ledger. Everything a scenario creates (an object, a follow, a vote) and everything
// it expects to be undone (an Undo that peblish must deliver) is appended to a run file at
// the moment it is created, so a run that stops half way still leaves a complete list.
// cleanup.ts reads the file and puts the lab back: deleting, unfollowing, clearing votes, and
// checking that each Undo arrived. The file is JSON lines: appending never rewrites earlier lines,
// and a `done` line closes an entry.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { RESULTS_DIR } from './lab.ts';
import type { PeerName } from './peers/types.ts';

/** Where something lives: peblish, or one of the peers. */
export type Side = 'peblish' | PeerName;

export type Entry =
  /** A post or comment a scenario created (by its author's account on `side`). */
  | {
      kind: 'object';
      side: Side;
      user: string;
      type: 'post' | 'comment';
      apId: string;
      /** The peer's own id, when known. */ peerId?: number;
    }
  /** `user` on `side` follows a community: on peblish it is `handle`, on a peer `handle` is the peblish community. */
  | { kind: 'follow'; side: Side; user: string; community: string }
  /** `user` on `side` voted on `target` (a post or comment ap_id). */
  | { kind: 'vote'; side: Side; user: string; target: string; targetType: 'post' | 'comment'; peerId?: number }
  /** An Undo peblish must deliver (`Undo(Follow)` of a follow it dropped): checked in `deliveries`. */
  | { kind: 'undo'; activityType: 'Undo'; object: string; inboxHost: string };

export type Line = { id: number; run: string; at: string; entry: Entry } | { done: number; at: string; note: string };

export const ledgerPath = () => `${RESULTS_DIR}/ledger.jsonl`;

export function readLines(path = ledgerPath()): Line[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

/** Entries not closed by a `done` line. */
export function open(path = ledgerPath()): { id: number; run: string; entry: Entry }[] {
  const lines = readLines(path);
  const closed = new Set(lines.flatMap((line) => ('done' in line ? [line.done] : [])));
  return lines.flatMap((line) => ('entry' in line && !closed.has(line.id) ? [{ id: line.id, run: line.run, entry: line.entry }] : []));
}

export function ledger(run: string, path = ledgerPath()) {
  mkdirSync(path.slice(0, path.lastIndexOf('/')) || '.', { recursive: true });
  let next = readLines(path).reduce((max, line) => Math.max(max, 'id' in line ? line.id : 0), 0);
  return {
    path,
    /** Appends before returning: call it right after the creation succeeds, before anything can fail. */
    add(entry: Entry): number {
      next += 1;
      appendFileSync(path, `${JSON.stringify({ id: next, run, at: new Date().toISOString(), entry } satisfies Line)}\n`);
      return next;
    },
    done(id: number, note = '') {
      appendFileSync(path, `${JSON.stringify({ done: id, at: new Date().toISOString(), note } satisfies Line)}\n`);
    },
  };
}
