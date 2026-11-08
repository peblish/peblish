// Deliberate boundary violation (tests/boundaries.test.ts): issuing a grant outside authorize().
import { issueGrant } from '../authz/brand.ts';

export const violation = issueGrant;
