// Deliberate boundary violation (tests/boundaries.test.ts): product code imports a tool.
import { tool } from '../../../../tools/__fixtures__/example-tool.ts';

export const violation = tool;
