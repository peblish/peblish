import type { Peer, PeerName } from './types.ts';
import { mbin } from './mbin.ts';
import { lemmy, piefed } from './threadiverse.ts';

const all: Record<PeerName, Peer> = { lemmy, piefed, mbin };

/** The peers named on the command line, or every available peer when none is. */
export function selectPeers(names: readonly string[]): Peer[] {
  const wanted = names.length > 0 ? names : (Object.keys(all) as PeerName[]);
  return wanted.flatMap((name) => {
    const peer = all[name as PeerName];
    return peer ? [peer] : [];
  });
}
