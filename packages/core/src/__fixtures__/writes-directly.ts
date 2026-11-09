// Deliberate boundary violation (tests/boundaries.test.ts): writing without a mutation.
import { writer } from '../db/write.ts';

export const violation = writer;
