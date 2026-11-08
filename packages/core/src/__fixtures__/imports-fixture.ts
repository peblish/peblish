// Deliberate boundary violation (tests/boundaries.test.ts): product code imports a fixture.
import { violation as minted } from './mints-grant.ts';

export const violation = minted;
