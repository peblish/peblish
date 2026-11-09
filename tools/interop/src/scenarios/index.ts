import type { Group } from '../context.ts';
import { comments } from './comments.ts';
import { follows } from './follows.ts';
import { mastodon } from './mastodon.ts';
import { posts } from './posts.ts';
import { votes } from './votes.ts';

/** Scenario groups in run order; each runs in its own process (run.ts). */
export const groups: Record<string, Group> = { follows, posts, comments, votes, mastodon };
