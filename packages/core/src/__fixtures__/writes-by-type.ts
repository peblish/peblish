// Allowed (tests/boundaries.test.ts): a type-only import of the write handle.
import type { WriteTx } from '../db/write.ts';

export type Allowed = WriteTx;
