// Deliberate boundary violation (tests/boundaries.test.ts): a raw transaction outside a mutation.
import { tx } from '../tx/tx.ts';

export const violation = tx;
