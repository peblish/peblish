import type { Group } from '../context.ts';
import { follows } from './follows.ts';

/** Scenario groups in run order; each runs in its own process (run.ts). */
export const groups: Record<string, Group> = { follows };
