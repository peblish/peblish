// What a scenario group is handed: the recorder, the peers under test, the run's tag, and
// peblish's own community (the one the peers follow).
import type { Uuid } from '@peblish/schema/ids';
import type { Recorder } from './lab.ts';
import type { ledger } from './ledger.ts';
import type { Sql } from './match.ts';
import type { Peer } from './peers/types.ts';

export type PeblishCommunity = { id: Uuid; apId: string; handle: string; name: string };

export type Context = {
  rec: Recorder;
  /** The peers this invocation runs against (`PEERS`). */
  peers: readonly Peer[];
  /** Tags names and titles of this run (MMDDHHMMSS). */
  run: string;
  /** When this invocation started; matcher queries use it so older rows never match. */
  since: Date;
  sql: Sql;
  /** Everything a scenario creates goes here at once, for cleanup. */
  ledger: ReturnType<typeof ledger>;
  community: PeblishCommunity;
  /** Also run the slow tier (the Follow resend at 5 and 15 minutes). */
  slow: boolean;
};

/** A scenario group: the ids it can produce, and the function that runs them. */
export type Group = {
  /** Scenario ids, for `ONLY=` and the table in INTEROP.md. */
  ids: readonly string[];
  run: (ctx: Context) => Promise<void>;
};
