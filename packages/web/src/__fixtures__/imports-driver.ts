// Deliberate boundary violation (tests/boundaries.test.ts): web imports the database driver.
import postgres from 'postgres';

export const violation = postgres;
