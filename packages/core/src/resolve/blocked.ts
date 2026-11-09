import { db } from '../db/read.ts';
import { blockedDomains, instanceBlocked } from '../peers/gate.ts';

// Instance blocks as the resolver and the directory see them, read from lane MODF's peer
// controls (peers/gate.ts). The resolver refuses a blocked host with `instance.blocked` before
// and during a lookup, and the directory leaves a blocked host's communities out.

/** Whether `host` (lowercase, with its port when it is not the default) is a blocked instance. */
export async function hostBlocked(host: string): Promise<boolean> {
  return instanceBlocked(db(), `https://${host}/`);
}

/** The blocked instances' domains, for a list that must leave them out. */
export async function blockedHosts(): Promise<string[]> {
  return blockedDomains();
}
