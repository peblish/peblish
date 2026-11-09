import type { MessageKey } from '../../i18n/translate.ts';

// The composer's data and its error codes, shared by the server (the loader, the form handler)
// and the browser. Plain data only: nothing here imports server code.

export const postTypes = ['text', 'link', 'image'] as const;
export type PostType = (typeof postTypes)[number];

/** A community the picker lists. Remote ones are those the person follows. */
export interface PickerCommunity {
  id: string;
  /** `name` for a local community, `name@host` for a remote one. */
  handle: string;
  local: boolean;
  /** Null where this instance does not know (a remote community). */
  subscribers: number | null;
  /** False when posting is restricted to moderators and the person is none. */
  canPost: boolean;
  restricted: boolean;
}

/** What the page beside the form shows about the chosen community. */
export interface CommunityPanel {
  id: string;
  handle: string;
  /** The community's page (its full rules and age policy). */
  href: string;
  /** The first lines of the sidebar text, as plain text. */
  summary: string | null;
  /** Local communities only: what the moderators ask posters to read first. */
  warning: string | null;
  rules: { title: string; html: string | null }[];
  /** Every post in it is marked sensitive. */
  sensitive: boolean;
  restricted: boolean;
  canPost: boolean;
}

/** The post being edited, as its author sees it. */
export interface EditTarget {
  id: string;
  community: string;
  title: string;
  /** Set for a link post. */
  url: string | null;
  bodyMd: string;
  sensitive: boolean;
}

export type Unavailable = 'signed-out' | 'not-found' | 'not-author' | 'deleted' | 'removed' | 'gated';

export type ComposerData =
  | { status: 'unavailable'; reason: Unavailable }
  | {
      status: 'ready';
      /** `@name@host`, for "Posting as". */
      me: string;
      communities: PickerCommunity[];
      /** The community chosen to start with, or null. */
      selected: string | null;
      panel: CommunityPanel | null;
      /** uploads.enabled: the Image type is offered only while it is on. */
      uploads: boolean;
      edit: EditTarget | null;
    };

/** The codes the composer has a message for: field problems, refusals a post can meet, and the web's own. */
export const composerErrors = [
  'community.required',
  'title.required',
  'title.too_long',
  'url.required',
  'url.invalid',
  'body.too_long',
  'image.required',
  'auth.required',
  'auth.email_unverified',
  'auth.actor_deleted',
  'community.posting_restricted',
  'community.banned',
  'community.removed',
  'community.deleted',
  'target.not_found',
  'target.deleted',
  'target.removed',
  'post.author_required',
  'site.disabled',
  'rate.limited',
  'media.unsupported_type',
  'media.invalid_image',
  'media.too_large',
  'generic',
  'network',
] as const;

export type ComposerError = (typeof composerErrors)[number];

const known: ReadonlySet<string> = new Set(composerErrors);

/** A code from the URL or the server, as one the composer has a message for. */
export function asComposerError(code: string | undefined | null): ComposerError | undefined {
  if (!code) return undefined;
  return known.has(code) ? (code as ComposerError) : 'generic';
}

/** The form control a code is about, so the message sits beside it. Null codes show above the buttons. */
export function errorField(code: ComposerError): 'community' | 'title' | 'url' | 'body' | 'image' | null {
  switch (code) {
    case 'community.required':
      return 'community';
    case 'title.required':
    case 'title.too_long':
      return 'title';
    case 'url.required':
    case 'url.invalid':
      return 'url';
    case 'body.too_long':
      return 'body';
    case 'image.required':
    case 'media.unsupported_type':
    case 'media.invalid_image':
    case 'media.too_large':
      return 'image';
    default:
      return null;
  }
}

/** Where a code's message lives: media refusals have theirs in the media catalogue (lane B2). */
export function errorMessageKey(
  code: ComposerError,
): { area: 'media'; key: MessageKey<'media'> } | { area: 'composer'; key: MessageKey<'composer'> } {
  switch (code) {
    case 'media.unsupported_type':
    case 'media.invalid_image':
    case 'media.too_large':
      return { area: 'media', key: `error.${code}` };
    case 'site.disabled':
      return { area: 'media', key: 'error.upload.disabled' };
    default:
      return { area: 'composer', key: `error.${code}` };
  }
}
