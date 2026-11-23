import type { InboxItem } from '@peblish/core/notifications/view';
import { commentPath, communityPath, postPath } from '../../../shell/paths.ts';

/**
 * Where a notice's link goes: its comment or its post, or, for a reply or mention that withholds
 * its post (readInbox leaves the id out when it names no one), the community it is in. A follow's
 * answer leads to its community (its headline already names it).
 */
export function noticeTarget(item: Pick<InboxItem, 'kind' | 'postId' | 'commentId' | 'community'>): string | null {
  if (item.postId) return item.commentId ? commentPath(item.postId, item.commentId) : postPath(item.postId);
  if (item.community && (item.kind === 'reply' || item.kind === 'mention' || item.kind === 'follow_accept'))
    return communityPath(item.community);
  return null;
}
