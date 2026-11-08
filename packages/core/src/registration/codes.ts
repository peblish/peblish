import { createHash, randomInt } from 'node:crypto';
import type { InviteStatus } from '@peblish/schema/invite';
import type { RefusalReason } from '@peblish/schema/refusal';

// Invite codes look like PB-7K2Q-XM4D: eight characters from an alphabet without look-alikes
// (no 0/O, 1/I/L, U), about 39 bits. Only the SHA-256 of the normalized code is stored.

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newInviteCode(): string {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `PB-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Case and separators do not matter: pb 7k2q xm4d is PB-7K2Q-XM4D. */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function inviteCodeHash(input: string): string {
  return createHash('sha256').update(normalizeInviteCode(input)).digest('hex');
}

export type InviteState = { maxUses: number; useCount: number; expiresAt: Date | null; revokedAt: Date | null };

/** Revoked wins over expired, expired over used up. */
export function inviteStatus(invite: InviteState | undefined, now = new Date()): InviteStatus {
  if (!invite) return 'unknown';
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (invite.useCount >= invite.maxUses) return 'exhausted';
  return 'valid';
}

export const inviteRefusal = {
  unknown: 'invite.unknown',
  revoked: 'invite.revoked',
  expired: 'invite.expired',
  exhausted: 'invite.exhausted',
} as const satisfies Record<Exclude<InviteStatus, 'valid'>, RefusalReason>;
