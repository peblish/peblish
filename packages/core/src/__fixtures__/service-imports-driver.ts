// Deliberate boundary violation (tests/boundaries.test.ts): a core service opens the driver.
import postgres from 'postgres';

export const violation = postgres;
