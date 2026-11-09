import type { Group } from '../context.ts';
import { comments } from './comments.ts';
import { follows } from './follows.ts';
import { mastodon } from './mastodon.ts';
import { matrix } from './matrix.ts';
import { missing } from './missing.ts';
import { moderation } from './moderation.ts';
import { protocol } from './protocol.ts';
import { posts } from './posts.ts';
import { votes } from './votes.ts';

/** Scenario groups in run order; each runs in its own process (run.ts). */
export const groups: Record<string, Group> = { follows, posts, comments, votes, mastodon, matrix, missing, moderation, protocol };
