// The seam for lane MODF's instance blocks. Until root swaps these two bodies for
// `isInstanceBlocked(domain)` and `blockedInstanceDomains()` from `peers/`, no host is blocked.
// The resolver refuses a blocked host with `instance.blocked` before and during a lookup, and
// the directory leaves a blocked host's communities out.

/** Whether `host` (lowercase, with its port when it is not the default) is a blocked instance. */
export async function hostBlocked(_host: string): Promise<boolean> {
  return false;
}

/** The blocked instances' domains, for a list that must leave them out. */
export async function blockedHosts(): Promise<string[]> {
  return [];
}
