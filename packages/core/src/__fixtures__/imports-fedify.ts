// Deliberate boundary violation (tests/boundaries.test.ts): Fedify outside packages/federation.
import { createFederation } from '@fedify/fedify';

export const violation = createFederation;
