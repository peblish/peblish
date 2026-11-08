import { createHash } from 'node:crypto';

/**
 * A deterministic uuidv7 for a fixture row: the 48-bit millisecond timestamp of `at`, then
 * bits of SHA-256(`name`) where v7 has random bits. Rebuilding a set gives the same ids,
 * and they still sort by time like the application's uuidv7s.
 */
export function fixtureUuid(name: string, at: Date | null): string {
  const bytes = createHash('sha256').update(`peblish-fixture:${name}`).digest().subarray(0, 16);
  const ms = BigInt(Math.max(0, at?.getTime() ?? 0));
  for (let index = 0; index < 6; index++) bytes[index] = Number((ms >> BigInt(8 * (5 - index))) & 0xffn);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
