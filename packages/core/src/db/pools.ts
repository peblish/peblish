import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { databaseUrl } from '../config.ts';

// Two pools on one database. The read pool's sessions start with
// default_transaction_read_only, so a write that bypasses tx() fails at runtime as well as
// in lint (only c/db, c/tx and c/outbox may import the write side).

function connect(readOnly: boolean) {
  const client = postgres(databaseUrl(), {
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    onnotice: () => {},
    connection: {
      application_name: readOnly ? 'peblish-read' : 'peblish-write',
      default_transaction_read_only: readOnly,
      // Reads are short statements; a misestimated feed plan once spent 166 of 301 ms on JIT. A string, because postgres.js drops a falsy startup value.
      // Custom plans only: postgres.js prepares every statement, and a cached generic plan cannot see the page's clock, the Top period or the viewer's follows.
      ...(readOnly && { jit: 'off', plan_cache_mode: 'force_custom_plan' }),
    },
  });
  return { client, db: drizzle({ client }) };
}

type Pool = ReturnType<typeof connect>;
type Pools = { read?: Pool; write?: Pool };

declare global {
  var peblishPools: Pools | undefined;
}

// One pair per process, kept on globalThis: a bundle can carry two copies of this module
// (the web build has one in Nitro's server entry, which runs the shutdown hook, and one in
// the SSR bundle, which serves requests), and closePools() from either must close both.
const pools = (globalThis.peblishPools ??= {});

export const readPool = (): Pool => (pools.read ??= connect(true));
export const writePool = (): Pool => (pools.write ??= connect(false));

/** Closes both pools (tests, worker shutdown, CLI scripts, the web server's close hook). */
export async function closePools(): Promise<void> {
  const open = [pools.read, pools.write].filter((pool) => pool !== undefined);
  pools.read = pools.write = undefined;
  await Promise.all(open.map(({ client }) => client.end({ timeout: 5 })));
}
