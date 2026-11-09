// Deliberate boundary violation (tests/boundaries.test.ts): a two-file runtime cycle.
import { b } from './cycle-b.ts';

export const a = () => b;
