import { type } from 'arktype';
import { Uuid } from './ids.ts';

// Owned by lane AZ after G0.

/** Work the instance does as itself, through its Application actor. */
export const SystemJob = type("'registration' | 'import' | 'scheduled'");
export type SystemJob = typeof SystemJob.infer;

/** Who granted an authorization. Stored in the modlog with every moderation action, so it is plain data. */
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
  })
  .or({
    /**
     * An actor acting on its own object, local or remote. For a remote principal delivered
     * directly, the inbound pipeline has already verified that the signing actor is the
     * object's attributedTo, so the policy only checks ownership.
     */
    kind: "'owner'",
    actorId: Uuid,
  })
  .or({
    /** The instance acting for a system job; ref names the invite, import batch or job run. */
    kind: "'system'",
    actorId: Uuid,
    job: SystemJob,
    ref: 'string | null',
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
  })
  .or({
    /**
     * The instance itself: actorId is the local instance actor (kind Application), so grants
     * and modlog rows always name a real actor. Get one from systemPrincipal() in core.
     */
    kind: "'system'",
    actorId: Uuid,
    job: SystemJob,
  });
export type Principal = typeof Principal.infer;
export type ActingPrincipal = Exclude<Principal, { kind: 'anonymous' }>;
export type SystemPrincipal = Extract<Principal, { kind: 'system' }>;
