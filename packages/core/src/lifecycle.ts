import { closePools } from './db/pools.ts';

/** Releases core's database connections; call once on process shutdown. */
export async function shutdown(): Promise<void> {
  await closePools();
}
