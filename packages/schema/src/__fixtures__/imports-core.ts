// Deliberate boundary violation (tests/boundaries.test.ts): schema imports core.
import { db } from '@peblish/core/db/read';

export const violation = db;
