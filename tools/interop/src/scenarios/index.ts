import type { Group } from '../context.ts';
import { accounts } from './accounts.ts';
import { bans } from './bans.ts';
import { comments } from './comments.ts';
import { follows } from './follows.ts';
import { groupEdit } from './groupedit.ts';
import { mastodon } from './mastodon.ts';
import { matrix } from './matrix.ts';
import { missing } from './missing.ts';
import { newAuthor } from './newauthor.ts';
import { moderation } from './moderation.ts';
import { resend } from './slow.ts';
import { protocol } from './protocol.ts';
import { reports } from './reports.ts';
import { posts } from './posts.ts';
import { votes } from './votes.ts';

/** Scenario groups in run order; each runs in its own process (run.ts). */
export const groups: Record<string, Group> = {
  follows,
  posts,
  comments,
  votes,
  mastodon,
  matrix,
  missing,
  moderation,
  protocol,
  groupEdit,
  accounts,
  newAuthor,
  reports,
  bans,
  resend,
};
