import type { Principal } from '@peblish/schema/authz';
import type { ContentRef, Uuid } from '@peblish/schema/ids';
import type { BanInput, ModInput } from '@peblish/schema/modlog';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { banFromCommunity, unbanFromCommunity } from '../moderation/ban.ts';
import { removeContent, restoreContent } from '../moderation/remove.ts';
import { banFromSite, unbanFromSite } from './site.ts';

// The moderator's actions as the web calls them (the modlog's POST /modlog/act): authorize, run
// the mutation, and answer with a result, a refusal from the precheck or from the recheck
// inside the transaction alike. Callers validate the input first.

export async function removeAs(principal: Principal, target: ContentRef, input: ModInput): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('mod.remove', principal, { target });
  if (!decision.ok) return decision;
  return refusedAsResult(() => removeContent(decision.grant, input));
}

export async function restoreAs(principal: Principal, target: ContentRef, input: ModInput): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('mod.restore', principal, { target });
  if (!decision.ok) return decision;
  return refusedAsResult(() => restoreContent(decision.grant, input));
}

export async function banAs(
  principal: Principal,
  subject: { communityId: Uuid; targetActorId: Uuid },
  input: BanInput,
): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('mod.ban', principal, subject);
  if (!decision.ok) return decision;
  return refusedAsResult(() => banFromCommunity(decision.grant, input));
}

export async function unbanAs(
  principal: Principal,
  subject: { communityId: Uuid; targetActorId: Uuid },
  input: ModInput,
): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('mod.unban', principal, subject);
  if (!decision.ok) return decision;
  return refusedAsResult(() => unbanFromCommunity(decision.grant, input));
}

export async function siteBanAs(principal: Principal, targetActorId: Uuid, input: BanInput): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('mod.site_ban', principal, { targetActorId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => banFromSite(decision.grant, input));
}

export async function siteUnbanAs(principal: Principal, targetActorId: Uuid, input: ModInput): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('mod.site_unban', principal, { targetActorId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => unbanFromSite(decision.grant, input));
}
