import { sidebarCommunities } from '@peblish/core/feeds/shell';
import type { SessionView } from '@peblish/schema/session';
import type { ActorRef } from '@peblish/schema/views';

/**
 * What the sidebar shows beyond its fixed links. The root loader fetches it once per
 * document (and again after `router.invalidate()`), so a page that changes it, such as a
 * subscribe button, invalidates the router.
 */
export interface ShellData {
  local: ActorRef[];
  remote: ActorRef[];
  /** How many communities the viewer moderates; the Moderating feed link shows when above 0. */
  moderating: number;
}

/**
 * Called from the root loader's server function (shell/root-data.ts), on the server only: a
 * plain function, because a server function called from inside another one is missing from
 * the production build's function table.
 *
 * A signed-in viewer gets the communities they follow (local and remote, pending follows
 * included) and how many they moderate; a signed-out one (`session` null) the local
 * communities. `session` is the root loader's own view of the viewer.
 */
export async function loadShellData(session: SessionView | null): Promise<ShellData> {
  return sidebarCommunities(session?.actorId ?? null);
}
