import type { SQL } from 'drizzle-orm';
import type { Uuid } from '@peblish/schema/ids';

// Item types for the glob registries in this folder (the *.gen.ts files are generated).

/**
 * A condition every feed query applies, contributed by an area (blocks, NSFW gate, instance
 * blocks) from <area>/feed-predicate.ts. Lane C1 owns the feed query that applies them.
 */
export interface FeedPredicate {
  readonly name: string;
  /** SQL over the posts table for `viewer` (null when signed out), or undefined for no filter. */
  where(viewer: { actorId: Uuid } | null): SQL | undefined;
}
