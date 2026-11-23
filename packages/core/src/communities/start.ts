import { Uuid } from '@peblish/schema/ids';
import { communityBlockedFor, findCommunityId, readCommunity, type CommunityDetail } from './read.ts';

/**
 * The community `key` names (an id, or a handle with or without `!`: `name` here, `name@host`
 * elsewhere) as the composer may show it to this member (web's picker and panel), or null. Only
 * one they could see in the directory or on its own page: live (readCommunity), past the age gate
 * (a sensitive or NSFL one only once they declared 16+), and not hidden by the directory's block
 * rules (communityBlockedFor: theirs, or this server's for its host). Whether they may post there
 * is not asked: in a mods-only community, one that bans them, or as a member who has not verified
 * their email, the form starts in it and says why it cannot post (its panel, then the submit's
 * refusal). One they could not see starts the form as if none had been asked for, and the
 * composer sends nothing of it.
 */
export async function composerCommunity(viewer: { actorId: Uuid; declared: boolean }, key: string): Promise<CommunityDetail | null> {
  const trimmed = key.trim().replace(/^!/, '');
  if (!trimmed) return null;
  const id = Uuid.allows(trimmed) ? trimmed : await findCommunityId(trimmed);
  const community = id ? await readCommunity({ id }) : null;
  if (!community || ((community.sensitive || community.nsfl) && !viewer.declared)) return null;
  return (await communityBlockedFor(viewer.actorId, community.actor.id)) ? null : community;
}
