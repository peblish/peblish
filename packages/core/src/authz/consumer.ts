import { defineConsumer } from '../outbox/consumers.ts';
import { moderatorCache } from './moderators-cache.ts';

// Owned by lane AZ. Drops the cached moderator roles a mod.role event makes stale, in the
// process that runs the consumers (the worker). Other processes rely on the cache's TTL;
// their writes are correct either way, because a mutation's recheck never reads the cache.
export const consumer = defineConsumer({
  name: 'authz.moderator-cache',
  events: ['mod.role'],
  startAt: 'beginning',
  async handle(event) {
    moderatorCache().invalidate(event);
  },
});
