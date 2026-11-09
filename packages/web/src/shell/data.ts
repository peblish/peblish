import { sidebarCommunities } from '@peblish/core/feeds/shell';
import { currentSession } from '@peblish/core/identity/session';
import type { SessionView } from '@peblish/schema/session';
import type { ActorRef } from '@peblish/schema/views';
import { getRequestHeader } from '@tanstack/react-start/server';

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
 * included) and how many they moderate; a signed-out one the local communities. `session` is
 * the root loader's own, when it has it (undefined: read it from the cookie here, without
 * touching the response, so the loader's cookie refresh is not repeated).
 */
export async function loadShellData(session?: SessionView | null): Promise<ShellData> {
  const cookie = getRequestHeader('cookie');
  const viewer = session !== undefined ? session : cookie ? ((await currentSession(new Headers({ cookie })))?.view ?? null) : null;
  return sidebarCommunities(viewer?.actorId ?? null);
}
