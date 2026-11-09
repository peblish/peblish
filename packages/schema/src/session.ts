import { type } from 'arktype';
import { Uuid } from './ids.ts';

// Lane A fills this from better-auth; lane A owns its evolution through root.
/** What the web app knows about the current request's signed-in user. */
export const SessionView = type({
  userId: Uuid,
  actorId: Uuid,
  name: 'string',
  displayName: 'string | null',
  siteRole: "'user' | 'admin'",
  emailVerified: 'boolean',
  twoFactorEnabled: 'boolean',
  /** Neutral 16+ declaration time; null means not yet declared (NSFW stays hidden). */
  ageDeclaredAt: 'string.date.iso | null',
});
export type SessionView = typeof SessionView.infer;
