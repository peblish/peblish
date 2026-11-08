// Deliberate boundary violation (tests/boundaries.test.ts): web reaches core/db through a resolved import.
import { db } from '@peblish/core/db/read';

export const violation = db;
