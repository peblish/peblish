import { CommunityInput, communityRulesMax, type CommunityPatch } from '@peblish/core/communities/input';
import { ACTOR_NAME } from '@peblish/schema/actor-urls';
import { type } from 'arktype';

// What the community form is made of, in the browser and on the server: the values as typed, the
// patch core's CommunityInput judges, and which field is wrong. One function decides both sides,
// so a problem the browser shows is the one the server would refuse for.

/** The languages the form offers (the mock): German, English, French, Spanish, Italian, Dutch, Polish, Turkish and undetermined. */
export const formLanguages = ['de', 'en', 'fr', 'es', 'it', 'nl', 'pl', 'tr', 'und'] as const;

export interface FormValues {
  /** Only a new community has one; it is fixed once created. */
  name: string;
  displayName: string;
  description: string;
  /** Titles are edited here; a rule's longer text (`body`, Markdown) rides along unchanged. */
  rules: { title: string; body: string }[];
  languages: string[];
  sensitive: boolean;
  nsfl: boolean;
  restricted: boolean;
  discoverable: boolean;
  indexable: boolean;
}

export const emptyValues: FormValues = {
  name: '',
  displayName: '',
  description: '',
  rules: [],
  languages: [],
  sensitive: false,
  nsfl: false,
  restricted: false,
  discoverable: true,
  indexable: true,
};

/** A form field that can be wrong, for the message beside it. */
export type FieldProblem = 'name' | 'displayName' | 'description' | 'rules' | 'languages';

/** Browsers send a textarea's line breaks as CRLF; the community keeps LF. */
const lineFeeds = (text: string) => text.replace(/\r\n?/g, '\n');

/** The most rule rows a post can carry; more are a mistake or abuse, not a rule list. */
const ruleRowsMax = communityRulesMax * 4;

/** The values a posted form carries. Field names: `name`, `displayName`, `description`, `rules.<i>.title` and `.body`, `lang.<code>`, and the checkboxes. */
export function readFormValues(form: FormData): FormValues {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === 'string' ? lineFeeds(value) : '';
  };
  const rules: FormValues['rules'] = [];
  for (let index = 0; index < ruleRowsMax; index++) {
    if (!form.has(`rules.${index}.title`)) continue;
    rules.push({ title: text(`rules.${index}.title`), body: text(`rules.${index}.body`) });
  }
  return {
    name: text('name').trim(),
    displayName: text('displayName'),
    description: text('description'),
    rules,
    languages: formLanguages.filter((code) => form.has(`lang.${code}`)),
    sensitive: form.has('sensitive'),
    nsfl: form.has('nsfl'),
    restricted: form.has('restricted'),
    discoverable: form.has('discoverable'),
    indexable: form.has('indexable'),
  };
}

/** The patch for core: every field is sent, so an edit replaces what is stored. A row without a title is no rule; an empty title or text clears. */
export function toPatch(values: FormValues): CommunityPatch {
  return {
    displayName: values.displayName.trim() || null,
    description: values.description.trim() || null,
    rules: values.rules.filter((rule) => rule.title.trim() !== '').map((rule) => ({ title: rule.title, body: rule.body.trim() || null })),
    languages: values.languages,
    sensitive: values.sensitive || values.nsfl,
    nsfl: values.nsfl,
    postingRestrictedToMods: values.restricted,
    discoverable: values.discoverable,
    indexable: values.indexable,
  };
}

const problemFields = new Set<string>(['displayName', 'description', 'rules', 'languages']);

/** What is wrong with the values, by field; empty when core would take them. `creating` also judges the name. */
export function problemsOf(values: FormValues, creating: boolean): Partial<Record<FieldProblem, true>> {
  const problems: Partial<Record<FieldProblem, true>> = {};
  if (creating && !ACTOR_NAME.test(values.name)) problems.name = true;
  const checked = CommunityInput(toPatch(values));
  if (checked instanceof type.errors) {
    for (const error of checked) {
      const field = String(error.path[0] ?? '');
      if (problemFields.has(field)) problems[field as FieldProblem] = true;
    }
  }
  return problems;
}

export { communityRulesMax };
