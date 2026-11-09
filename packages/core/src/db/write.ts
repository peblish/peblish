import { writePool } from './pools.ts';

// The only writable handle. Lint allows importing this module from c/db, c/tx and
// c/outbox only; everything else writes through a mutation (c/tx/mutation.ts).
export const writer = () => writePool().db;

export type Writer = ReturnType<typeof writer>;
export type WriteTx = Parameters<Parameters<Writer['transaction']>[0]>[0];
