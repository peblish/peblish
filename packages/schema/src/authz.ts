import { type } from 'arktype';
import { Uuid } from './ids.ts';

// Owned by lane AZ after G0. Who granted an authorization. Stored in the modlog with every
// moderation action, so it is plain data.
export const Authority = type({
  kind: "'local-role'",
  actorId: Uuid,
  /** user: any signed-in local actor; moderator and owner are per community. */
  role: "'user' | 'moderator' | 'owner'",
  communityId: Uuid.or('null'),
})
  .or({ kind: "'site-admin'", actorId: Uuid })
  .or({
    /** A remote moderation action relayed by the owning community's Announce (decision 10). */
    kind: "'community-announce'",
    communityId: Uuid,
    announceApId: 'string.url',
  });
export type Authority = typeof Authority.infer;

/** Who is asking. Anonymous principals are refused before any policy runs. */
export const Principal = type({ kind: "'anonymous'" })
  .or({ kind: "'local'", actorId: Uuid, siteRole: "'user' | 'admin'" })
  .or({
    kind: "'remote'",
    actorId: Uuid,
    /** Set when the activity reached us inside an Announce from this community. */
    announcedBy: type({ communityId: Uuid, announceApId: 'string.url' }).or('null'),
  });
export type Principal = typeof Principal.infer;
export type ActingPrincipal = Exclude<Principal, { kind: 'anonymous' }>;
