// Deliberate boundary violation (tests/boundaries.test.ts): a raw transaction in federation outside inbound/ and delivery/.
import { tx } from '@peblish/core/tx/tx';

export const violation = tx;
