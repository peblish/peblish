import { attempt } from '@peblish/core/identity/throttle';
import { fetchLinkPreview, type LinkPreview } from '@peblish/core/links/preview';
import { localHandles } from '@peblish/core/identity/handles';
import { maxUploadBytes } from '@peblish/core/media/save';
import { uploadImage } from '@peblish/core/media/upload';
import { createPostAs, updatePostAs } from '@peblish/core/posts/actions';
import { NewPost, normalizeTitle, PostEdit } from '@peblish/core/posts/input';
import { readPost, type Viewer } from '@peblish/core/posts/read';
import { readSetting } from '@peblish/core/settings/read';
import type { ActingPrincipal } from '@peblish/schema/authz';
import { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { firstProblem } from './-fields.ts';
import { encodeKept, type Kept } from './-kept.ts';
import { asComposerError, type ComposerError, type PostType } from './-types.ts';

// The server half of the composer's form (server only: imported by the route's POST handler and
// its tests, never by the page). Like lane A's pages and the post page: without JavaScript the
// form posts to /submit and the answer is a 303 (to the post, or back with ?error=<code>); once
// hydrated it posts by fetch with Accept: application/json and reads { redirect } or { error }.

const Fields = type({
  'edit?': 'string',
  'community?': 'string',
  'type?': "'text' | 'link' | 'image'",
  'title?': 'string',
  'url?': 'string',
  'body?': 'string',
  'alt?': 'string',
  'nsfw?': 'string',
});

const altTextMaxLength = 1000;
/** The most the fields themselves can weigh: a 50,000-character body at four bytes a character, and slack. */
const fieldsBytes = 1024 * 1024;

export interface Submission {
  /** The post being edited, or null for a new one. */
  editing: string | null;
  community: string | null;
  type: PostType;
  title: string;
  url: string;
  body: string;
  alt: string;
  nsfw: boolean;
  /** The chosen file, for an image post. */
  image: Uint8Array | null;
}

/** Browsers send a textarea's line breaks as CRLF; the post keeps LF. */
const lineFeeds = (text: string) => text.replace(/\r\n?/g, '\n');

/**
 * The form's fields as a submission, or the first thing wrong with them (-fields.ts). `NewPost`
 * and `PostEdit` (core) judge the whole once more before anything is written.
 */
export function parseSubmission(raw: Record<string, string>, image: Uint8Array | null): Submission | ComposerError {
  const fields = Fields(raw);
  if (fields instanceof type.errors) return 'generic';
  const editing = fields.edit ?? null;
  if (editing !== null && !Uuid.allows(editing)) return 'target.not_found';
  const community = fields.community !== undefined && Uuid.allows(fields.community) ? fields.community : null;
  const submission: Submission = {
    editing,
    community,
    type: fields.type ?? 'text',
    title: normalizeTitle(fields.title ?? ''),
    url: (fields.url ?? '').trim(),
    body: lineFeeds(fields.body ?? ''),
    alt: lineFeeds(fields.alt ?? '').slice(0, altTextMaxLength),
    nsfw: fields.nsfw !== undefined,
    image,
  };
  return firstProblem({ ...submission, creating: editing === null, hasImage: image !== null && image.byteLength > 0 }) ?? submission;
}

export type Read = { ok: true; fields: Record<string, string>; image: Uint8Array | null } | { ok: false; error: ComposerError };

/**
 * The form of a request. The body is read in pieces and dropped at the limit, so nobody can
 * make the server buffer more than a megabyte for text, plus the upload limit while uploads are
 * switched on: `media.too_large` past it, `generic` for a body that is no form at all.
 */
export async function readSubmission(request: Request): Promise<Read> {
  const limit = ((await readSetting('uploads.enabled')) ? maxUploadBytes : 0) + fieldsBytes;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return { ok: false, error: 'media.too_large' };
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return { ok: false, error: 'media.too_large' };
    }
    chunks.push(value);
  }
  try {
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();
    const fields: Record<string, string> = {};
    let image: Uint8Array | null = null;
    for (const [name, value] of form) {
      if (typeof value === 'string') fields[name] ??= value;
      else if (name === 'image' && value.size > 0) image = new Uint8Array(await value.arrayBuffer());
    }
    return { ok: true, fields, image };
  } catch {
    return { ok: false, error: 'generic' };
  }
}

type Outcome = { ok: true; id: string } | { ok: false; error: ComposerError };

const refused = (reason: string): Outcome => ({ ok: false, error: asComposerError(reason) ?? 'generic' });

type Who = { principal: ActingPrincipal; viewer: NonNullable<Viewer>; ip: string | null };

/** What a submission calls out to, so the order of its steps can be tested without a database or a network. */
export interface Deps {
  /** Counts a link preview against the budget (client address and account); false when over it. */
  throttle(principal: ActingPrincipal, ip: string | null): Promise<boolean>;
  preview: typeof fetchLinkPreview;
  upload: typeof uploadImage;
  /** This instance's origin, where an uploaded image will be served. */
  origin(): Promise<string>;
  /** The address a post links to now. */
  currentUrl(postId: string, viewer: NonNullable<Viewer>): Promise<string | null>;
  createPost: typeof createPostAs;
  updatePost: typeof updatePostAs;
}

const defaults: Deps = {
  throttle: async (principal, ip) => (await attempt('link-preview', { ip, id: principal.actorId })).allowed,
  preview: fetchLinkPreview,
  upload: uploadImage,
  origin: async () => (await localHandles()).origin,
  currentUrl: async (postId, viewer) => (await readPost(postId, viewer))?.view.url ?? null,
  createPost: createPostAs,
  updatePost: updatePostAs,
};

/**
 * The page's preview (C02), fetched before the post and outside its transaction, after the
 * request is counted against the link-preview budget: over it, the form is refused with
 * `rate.limited` like the other throttled forms. With previews switched off the post goes ahead
 * without one; an account that cannot post is refused here with the reason createPost would give.
 */
async function previewOf({ principal, ip }: Who, url: string, deps: Deps): Promise<LinkPreview | null | ComposerError> {
  if (!(await deps.throttle(principal, ip))) return 'rate.limited';
  const preview = await deps.preview(principal, url);
  if (preview.ok) return preview;
  return preview.reason === 'site.disabled' ? null : (asComposerError(preview.reason) ?? 'generic');
}

/** Creates or edits the post, and says where to go or what refused it. */
export async function submit(who: Who, input: Submission, deps: Deps = defaults): Promise<Outcome> {
  return input.editing === null ? create(who, input, deps) : edit(who, input.editing, input, deps);
}

async function create(who: Who, input: Submission, deps: Deps): Promise<Outcome> {
  const { principal } = who;
  const communityId = Uuid.assert(input.community);
  let preview: LinkPreview | null = null;
  let image: { url: string; contentType: string } | null = null;
  if (input.type === 'link') {
    const found = await previewOf(who, input.url, deps);
    if (typeof found === 'string') return { ok: false, error: found };
    preview = found;
  }
  if (input.type === 'image' && input.image) {
    const saved = await deps.upload(principal, { bytes: input.image, altText: input.alt || null });
    if (!saved.ok) return refused(saved.reason);
    image = { url: `${await deps.origin()}/media/${saved.id}`, contentType: saved.mimeType };
  }

  const title = input.title || normalizeTitle(preview?.title ?? '');
  if (title === '') return { ok: false, error: 'title.required' };
  // The preview's picture address and type are already checked (lane B2), so they pass as they are.
  const checked = NewPost({
    title,
    sensitive: input.nsfw,
    ...(input.type === 'text' && { bodyMd: input.body }),
    ...(input.type === 'link' && { url: input.url }),
    ...(preview && { thumbnailUrl: preview.thumbnailUrl, urlContentType: preview.urlContentType }),
    ...(image && { url: image.url, urlContentType: image.contentType, altText: input.alt || null }),
  });
  if (checked instanceof type.errors) return { ok: false, error: 'generic' };

  const created = await deps.createPost(principal, communityId, checked);
  return created.ok ? { ok: true, id: created.id } : refused(created.reason);
}

async function edit(who: Who, postId: string, input: Submission, deps: Deps): Promise<Outcome> {
  // A link post that now points somewhere else gets that page's preview; the old picture and type belong to the old page.
  const moved = input.type === 'link' && input.url !== (await deps.currentUrl(postId, who.viewer));
  let preview: LinkPreview | null = null;
  if (moved) {
    const found = await previewOf(who, input.url, deps);
    if (typeof found === 'string') return { ok: false, error: found };
    preview = found;
  }
  const checked = PostEdit({
    title: input.title,
    sensitive: input.nsfw,
    ...(input.type === 'text' && { bodyMd: input.body }),
    ...(input.type === 'link' && { url: input.url }),
    ...(moved && { thumbnailUrl: preview?.thumbnailUrl ?? null, urlContentType: preview?.urlContentType ?? null }),
  });
  if (checked instanceof type.errors) return { ok: false, error: 'generic' };

  const updated = await deps.updatePost(who.principal, postId, checked);
  return updated.ok ? { ok: true, id: postId } : refused(updated.reason);
}

/** Where a refused form goes back to, and what it keeps of what was typed. */
export interface Back {
  edit: string | null;
  kept: Kept;
}

/** The route's answer: JSON for the hydrated form, otherwise 303 to the post or back to the form with the error. */
export function answer(request: Request, cookies: readonly string[], outcome: Outcome, back: Back): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    const body = outcome.ok ? { redirect: `/post/${outcome.id}` } : { error: outcome.error };
    const status = outcome.ok ? 200 : outcome.error === 'rate.limited' ? 429 : 400;
    return new Response(JSON.stringify(body), { status, headers });
  }
  const search = new URLSearchParams();
  if (back.edit) search.set('edit', back.edit);
  if (!outcome.ok) {
    search.set('error', outcome.error);
    search.set('kept', encodeKept(back.kept));
  }
  headers.set('location', outcome.ok ? `/post/${outcome.id}` : `/submit?${search}`);
  return new Response(null, { status: 303, headers });
}

/** What the form had, as the `kept` parameter carries it back after a refusal without JavaScript. */
export function keptOf(raw: Record<string, string>): Kept {
  const fields = Fields(raw);
  if (fields instanceof type.errors) return {};
  return {
    ...(fields.community !== undefined && { community: fields.community }),
    ...(fields.type !== undefined && { type: fields.type }),
    title: fields.title ?? '',
    url: fields.url ?? '',
    body: fields.body === undefined ? '' : lineFeeds(fields.body),
    nsfw: fields.nsfw !== undefined,
  };
}
