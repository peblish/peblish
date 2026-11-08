// The Drizzle row types satisfy the shared entity types in @peblish/schema/entities, so the
// two never drift apart silently. Checked by tsc.
import type { Actor, Comment, Media, Post, Vote } from '@peblish/schema/entities';
import type { ModAction } from '@peblish/schema/modlog';
import type { actors } from './tables/actors.ts';
import type { comments, posts, votes } from './tables/content.ts';
import type { media } from './tables/media.ts';
import type { modlog } from './tables/moderation.ts';

type Satisfies<Row, Entity> = Row extends Entity ? true : never;

export type Checks = [
  Satisfies<typeof actors.$inferSelect, Actor>,
  Satisfies<typeof posts.$inferSelect, Post>,
  Satisfies<typeof comments.$inferSelect, Comment>,
  Satisfies<Omit<typeof votes.$inferSelect, 'value'> & { value: 1 | -1 }, Vote>,
  Satisfies<typeof media.$inferSelect, Media>,
  Satisfies<Omit<typeof modlog.$inferSelect, 'authority'> & { authority: ModAction['authority'] }, ModAction>,
];
export const checks: Checks = [true, true, true, true, true, true];
