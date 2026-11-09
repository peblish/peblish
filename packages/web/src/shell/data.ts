import { publicOrigin } from '@peblish/core/config';
import { sidebarCommunities } from '@peblish/core/feeds/shell';
import { unreadCount } from '@peblish/core/notifications/unread';
import { openReportCount } from '@peblish/core/reports/count';
import { readSetting } from '@peblish/core/settings/read';
import type { SessionView } from '@peblish/schema/session';
import type { ActorRef } from '@peblish/schema/views';

/**
 * What the sidebar shows beyond its fixed links. The root loader fetches it once per
 * document (and again after `router.invalidate()`), so a page that changes it, such as a
 * subscribe button, invalidates the router.
 */
export interface ShellData {
  /** The instance's name (site setting site.name), else its host: the sidebar brand and the end of every page title. */
  siteName: string;
  local: ActorRef[];
  remote: ActorRef[];
  /** How many communities the viewer moderates; the Moderating feed link shows when above 0. */
  moderating: number;
  /** The viewer's unread notices for the Inbox badge (lane E2), at most unreadCap; 0 when signed out. */
  unread: number;
  /** Open reports for the Moderation queue badge (lane REP); null when the viewer moderates nothing and is no admin, and then there is no link. */
  reportCount: number | null;
}

/** The host of PUBLIC_ORIGIN, the name a site without one goes by. */
const host = () => URL.parse(publicOrigin() ?? '')?.host ?? '';

/**
 * Called from the root loader's server function (shell/root-data.ts), on the server only: a
 * plain function, because a server function called from inside another one is missing from
 * the production build's function table.
 *
 * A signed-in viewer gets the communities they follow (local and remote, pending follows
 * included), how many they moderate, their unread count and, for moderators and admins, the
 * open report count; a signed-out one (`session` null) the local communities. `session` is
 * the root loader's own view of the viewer.
 */
export async function loadShellData(session: SessionView | null): Promise<ShellData> {
  const viewerId = session?.actorId ?? null;
  const [name, communities, unread] = await Promise.all([readSetting('site.name'), sidebarCommunities(viewerId), unreadCount(viewerId)]);
  const staff = session !== null && (communities.moderating > 0 || session.siteRole === 'admin');
  const reportCount = staff ? await openReportCount({ actorId: session.actorId, siteRole: session.siteRole }) : null;
  return { siteName: name || host(), ...communities, unread, reportCount };
}
