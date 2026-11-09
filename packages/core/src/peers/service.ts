import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { updatePeer, type PeerInput } from './update.ts';

/** The admin's change to a peer as the web calls it: authorize, run the mutation, answer with a result. */
export async function updatePeerAs(
  principal: Principal,
  domain: string,
  input: PeerInput,
): Promise<Result<{ instanceId: Uuid; modlogId: Uuid }>> {
  const decision = await authorize('peer.update', principal, { domain });
  if (!decision.ok) return decision;
  return refusedAsResult(() => updatePeer(decision.grant, input));
}
