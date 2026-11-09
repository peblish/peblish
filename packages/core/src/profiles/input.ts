import { type } from 'arktype';

// The editable fields of a local person's profile. Pure ArkType with no database import, so the
// edit form validates with the schema core enforces. Avatar, banner and extra fields come with
// uploads and are not here.

export const displayNameMax = 100;
export const bioMax = 2_000;

/** A key that is absent keeps the stored value; an empty name or bio, or null, clears it. */
export const ProfileInput = type({
  'displayName?': type('string.trim').to(`string <= ${displayNameMax}`).or('null'),
  /** Markdown. */
  'bio?': type('string.trim').to(`string <= ${bioMax}`).or('null'),
});
/** What a caller passes (before trimming). */
export type ProfilePatch = typeof ProfileInput.inferIn;
