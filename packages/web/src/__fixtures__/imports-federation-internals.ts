// Deliberate boundary violation (tests/boundaries.test.ts): web reaches past federation's HTTP seam.
import { createPeblishFederation } from '@peblish/federation/federation';

export const violation = createPeblishFederation;
