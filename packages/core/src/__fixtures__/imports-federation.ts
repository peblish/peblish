// Deliberate boundary violation (tests/boundaries.test.ts): core imports federation by path.
import type { InboundHandler } from '../../../federation/src/inbound/handler.ts';

export type Violation = InboundHandler;
