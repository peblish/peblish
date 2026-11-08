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
    connection: { application_name: readOnly ? 'peblish-read' : 'peblish-write', default_transaction_read_only: readOnly },
  });
  return { client, db: drizzle({ client }) };
}

type Pool = ReturnType<typeof connect>;
let read: Pool | undefined;
let write: Pool | undefined;

export const readPool = (): Pool => (read ??= connect(true));
export const writePool = (): Pool => (write ??= connect(false));

/** Closes both pools (tests, worker shutdown, CLI scripts). */
export async function closePools(): Promise<void> {
  const open = [read, write].filter((pool) => pool !== undefined);
  read = write = undefined;
  await Promise.all(open.map(({ client }) => client.end({ timeout: 5 })));
}
