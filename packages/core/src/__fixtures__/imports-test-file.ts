// Deliberate boundary violation (tests/boundaries.test.ts): product code imports a type test.
import type {} from '../tx/mutation.test-d.ts';

export const violation = 1;
