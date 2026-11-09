// Deliberate boundary violation (tests/boundaries.test.ts): Fedify reached by a resolved path.
import { createFederation } from '../../../federation/node_modules/@fedify/fedify/dist/mod.js';

export const violation = createFederation;
