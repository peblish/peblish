import { type } from 'arktype';
import { IsoDate, Uuid } from './ids.ts';

// Owned by lane A: invite-only registration (M20). Codes are stored hashed, so a code is
// shown once, when it is created; every later view names the invite by its label.

export const InviteStatus = type("'valid' | 'expired' | 'exhausted' | 'revoked' | 'unknown'");
export type InviteStatus = typeof InviteStatus.infer;

/** A local actor as a handle: name, and name@host for display. */
export const Handle = type({ name: 'string', handle: 'string' });
export type Handle = typeof Handle.infer;

/** What /invite/<code> and the sign-up form show about a code, without using it. */
export const InviteLookup = type({
  status: InviteStatus,
  /** The referrer: the invite chain's parent. Null for an unknown code. */
  inviter: Handle.or('null'),
  usesLeft: 'number.integer >= 0',
  maxUses: 'number.integer >= 0',
  expiresAt: IsoDate.or('null'),
});
export type InviteLookup = typeof InviteLookup.infer;

/** One row of the admin invites table. */
export const InviteRow = type({
  id: Uuid,
  label: 'string | null',
  referrer: Handle.or('null'),
  uses: 'number.integer >= 0',
  maxUses: 'number.integer > 0',
  expiresAt: IsoDate.or('null'),
  status: InviteStatus,
  createdAt: IsoDate,
  usedBy: Handle.and({ usedAt: IsoDate, emailVerified: 'boolean', deleted: 'boolean' }).array(),
});
export type InviteRow = typeof InviteRow.infer;

/** The admin's create-invite row; expiry is relative (days) or none. */
export const InviteCreateBody = type({
  label: 'string',
  referrer: 'string',
  maxUses: 'string',
  expires: "'7' | '30' | '90' | 'never'",
});
export type InviteCreateBody = typeof InviteCreateBody.infer;
