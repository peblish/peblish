// Deliberate boundary violation (tests/boundaries.test.ts): an import that resolves to nothing.
import { missing } from './does-not-exist.ts';

export const violation = missing;
