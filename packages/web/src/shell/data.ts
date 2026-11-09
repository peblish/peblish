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
 * Lane C1 takes this file over and fills it: for a signed-in viewer the communities they
 * subscribe to (local and remote), for a signed-out one the local communities.
 */
export async function loadShellData(): Promise<ShellData> {
  return { local: [], remote: [], moderating: 0 };
}
