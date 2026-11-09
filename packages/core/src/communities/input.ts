import { type } from 'arktype';

// The editable fields of a local community (lane F). Pure ArkType with no database import, so
// a web form validates with the same schema core enforces. The name is not here: it comes from
// the community.create subject and never changes (it is part of the ap_id).

/** Text trimmed first, then held to its length. An empty description, warning or rule body is stored as null. */
const displayName = type('string.trim').to('1 <= string <= 100');
const description = type('string.trim').to('string <= 10000');
const postingWarning = type('string.trim').to('string <= 500');
const ruleTitle = type('string.trim').to('1 <= string <= 200');
const ruleBody = type('string.trim').to('string <= 5000');
/** ISO 639-1 or 639-3 code in lower case, as posts.language holds it; 'und' for undetermined. */
const language = type(/^[a-z]{2,3}$/);

export const communityRulesMax = 15;
export const communityLanguagesMax = 50;

export const CommunityRuleInput = type({ title: ruleTitle, 'body?': ruleBody.or('null') });
export type CommunityRuleInput = typeof CommunityRuleInput.infer;

/**
 * What community.create takes besides the name and community.update takes as a patch: a key
 * that is absent keeps the stored value (create applies the defaults: nothing set, no age
 * gate, open posting); `languages` and `rules` replace the whole list when present. `sensitive`
 * is the age gate (the community allows NSFW), and `nsfl` implies it.
 */
export const CommunityInput = type({
  'displayName?': displayName.or('null'),
  /** The sidebar, in Markdown. */
  'description?': description.or('null'),
  'sensitive?': 'boolean',
  'nsfl?': 'boolean',
  'postingRestrictedToMods?': 'boolean',
  'postingWarning?': postingWarning.or('null'),
  'languages?': language.array().atMostLength(communityLanguagesMax),
  'rules?': CommunityRuleInput.array().atMostLength(communityRulesMax),
});
/** The form a caller passes (before trimming); the validated value is CommunityInput.infer. */
export type CommunityPatch = typeof CommunityInput.inferIn;
export type CommunityFields = typeof CommunityInput.infer;
