// Deliberate boundary violation (tests/boundaries.test.ts): product code imports a test helper.
import { truncateAll } from '../testing/db.ts';

export const violation = truncateAll;
