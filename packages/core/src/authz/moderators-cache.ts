import type { OutboxEvent } from '@peblish/schema/events';
import type { Uuid } from '@peblish/schema/ids';

export type CommunityRole = 'owner' | 'moderator';

type Entry = { role: CommunityRole; until: number };

/**
 * A bounded, positive-only cache of community roles: it remembers that an actor moderates a
 * community, never that one does not, so a newly appointed moderator is seen at once. Entries
 * live for `ttlMs` (or until the row's own expiry, if sooner), the least recently used entry
 * goes first beyond `maxEntries`, and a mod.role event drops the pair it names.
 *
 * Only authorize() without `lock` reads it. A recheck reads the database under lock, so a
 * stale entry can at most let a precheck pass that the mutation then refuses.
 */
export class ModeratorCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor({ maxEntries = 10_000, ttlMs = 60_000, now = Date.now }: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    if (!(maxEntries > 0 && ttlMs > 0)) throw new RangeError('the moderator cache needs a positive bound and TTL');
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(communityId: Uuid, actorId: Uuid): CommunityRole | undefined {
    const key = `${communityId}:${actorId}`;
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.until <= this.#now()) return undefined;
    this.#entries.set(key, entry); // most recently used now
    return entry.role;
  }

  /** Remembers a role read from a fresh community_moderators row; `expiresAt` is the row's. */
  set(communityId: Uuid, actorId: Uuid, role: CommunityRole, expiresAt: Date | null): void {
    const key = `${communityId}:${actorId}`;
    const until = Math.min(this.#now() + this.#ttlMs, expiresAt?.getTime() ?? Infinity);
    this.#entries.delete(key);
    this.#entries.set(key, { role, until });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(oldest);
    }
  }

  forget(communityId: Uuid, actorId: Uuid): void {
    this.#entries.delete(`${communityId}:${actorId}`);
  }

  /** Drops what a moderation event makes stale: the pair a mod.role event names. */
  invalidate(event: OutboxEvent): void {
    if (event.type === 'mod.role') this.forget(event.communityId, event.actorId);
  }

  clear(): void {
    this.#entries.clear();
  }
}

declare global {
  var peblishModeratorCache: ModeratorCache | undefined;
}

/** The process's cache, on globalThis because a bundle can carry two copies of this module. */
export const moderatorCache = (): ModeratorCache => (globalThis.peblishModeratorCache ??= new ModeratorCache());
