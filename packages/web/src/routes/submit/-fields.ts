import { normalizeTitle, postTitleMaxLength } from '@peblish/core/posts/input';
import { markdownMaxLength } from '@peblish/schema/markdown';
import type { ComposerError, PostType } from './-types.ts';

// The checks a form can fail with a message beside a field. The browser runs them before it
// posts and the server again on what arrives (-submit.ts), so both answer with the same code.
// Pure and browser-safe. `NewPost` and `PostEdit` (core) remain the judge of what is written.

const linkMaxLength = 2000;

/** An http or https address without credentials, as core's post input accepts. */
export function httpUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    value.length <= linkMaxLength
  );
}

export interface FieldValues {
  /** A new post, not an edit. */
  creating: boolean;
  community: string | null;
  type: PostType;
  title: string;
  url: string;
  body: string;
  hasImage: boolean;
}

/** The first problem with the fields, in the order the form shows them, or null. */
export function firstProblem(values: FieldValues): ComposerError | null {
  const { creating, type } = values;
  const title = normalizeTitle(values.title);
  const url = values.url.trim();
  if (creating && values.community === null) return 'community.required';
  // A new link post may leave the title empty: the linked page's title fills it in.
  if (title === '' && !(type === 'link' && creating)) return 'title.required';
  if ([...title].length > postTitleMaxLength) return 'title.too_long';
  if (type === 'link') {
    if (url === '') return 'url.required';
    if (!httpUrl(url)) return 'url.invalid';
  }
  if (type === 'text' && values.body.length > markdownMaxLength) return 'body.too_long';
  if (type === 'image' && creating && !values.hasImage) return 'image.required';
  return null;
}
