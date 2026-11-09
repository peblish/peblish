import { expect, test } from 'vitest';
import type { NewPost, PostEdit } from '@peblish/core/posts/input';
import type { ActingPrincipal } from '@peblish/schema/authz';
import { answer, parseSubmission, submit, type Deps, type Submission } from './-submit.ts';

const community = '0192f5a0-1234-7abc-8def-0123456789ab';
const parsed = (fields: Record<string, string>, image: Uint8Array | null = null) => parseSubmission(fields, image) as Submission;

test('the fields become a submission: line breaks are LF, the title is one line, the checkbox is a boolean', () => {
  expect(parsed({ community, title: '  Two\n  lines ', body: 'a\r\nb\rc', nsfw: 'on', alt: 'x' })).toEqual({
    editing: null,
    community,
    type: 'text',
    title: 'Two lines',
    url: '',
    body: 'a\nb\nc',
    alt: 'x',
    nsfw: true,
    image: null,
  });
  expect(parsed({ community, title: 't' }).nsfw).toBe(false);
});

test('what is wrong is named by its code', () => {
  expect(parseSubmission({ title: 't' }, null)).toBe('community.required');
  expect(parseSubmission({ community: 'not-a-uuid', title: 't' }, null)).toBe('community.required');
  expect(parseSubmission({ community, title: ' ' }, null)).toBe('title.required');
  expect(parseSubmission({ community, type: 'link', title: 't', url: 'x' }, null)).toBe('url.invalid');
  expect(parseSubmission({ community, type: 'image', title: 't' }, new Uint8Array())).toBe('image.required');
  expect(parseSubmission({ edit: 'nope', title: 't' }, null)).toBe('target.not_found');
  expect(parseSubmission({ community, type: 'poll', title: 't' }, null)).toBe('generic');
});

test('an edit needs no community and a link post made new may leave the title for the page to give', () => {
  expect(parsed({ edit: community, title: 'New title' }).editing).toBe(community);
  expect(parseSubmission({ edit: community, type: 'link', url: 'https://example.org/', title: '' }, null)).toBe('title.required');
  expect(parsed({ community, type: 'link', url: 'https://example.org/', title: '' }).title).toBe('');
});

// The order of a submission's steps, with its calls faked: no database, no network.
const principal: ActingPrincipal = { kind: 'local', actorId: '0192f5a0-1234-7abc-8def-0123456789aa', siteRole: 'user' };
const who = { principal, viewer: { actorId: principal.actorId, siteRole: 'user' as const }, ip: '203.0.113.7' };
const page = {
  ok: true as const,
  title: 'Page title',
  description: null,
  urlContentType: 'text/html',
  thumbnailUrl: 'https://img.test/a.png',
};

function fakes(over: Partial<Deps> = {}) {
  const created: NewPost[] = [];
  const edited: PostEdit[] = [];
  const calls: string[] = [];
  const deps: Deps = {
    throttle: async () => true,
    preview: async () => (calls.push('preview'), page),
    upload: async () => (
      calls.push('upload'),
      { ok: true, id: 'u1', storageKey: 'media/u1.png', mimeType: 'image/png', byteSize: 1, width: 1, height: 1, sha256: '0' }
    ),
    origin: async () => 'https://feddit.test',
    currentUrl: async () => 'https://old.test/',
    createPost: async (_principal, _community, input) => (
      calls.push('create'),
      created.push(input),
      { ok: true, id: 'p1', apId: 'https://feddit.test/p1' }
    ),
    updatePost: async (_principal, _post, input) => (calls.push('update'), edited.push(input), { ok: true, changed: true }),
    ...over,
  };
  return { deps, created, edited, calls };
}

const link = (extra: Record<string, string> = {}) => parsed({ community, type: 'link', url: 'https://example.org/a', ...extra });

test('a new link post takes the page title and picture the preview found, and posts after it', async () => {
  const { deps, created, calls } = fakes();
  expect(await submit(who, link({ title: '' }), deps)).toEqual({ ok: true, id: 'p1' });
  expect(calls).toEqual(['preview', 'create']);
  expect(created[0]).toMatchObject({
    title: 'Page title',
    url: 'https://example.org/a',
    thumbnailUrl: 'https://img.test/a.png',
    urlContentType: 'text/html',
  });
  // A title the person typed wins over the page's.
  expect((await createdWithTitle('Mine')).title).toBe('Mine');
});

async function createdWithTitle(title: string) {
  const { deps, created } = fakes();
  await submit(who, link({ title }), deps);
  return created[0]!;
}

test('with previews off the post goes ahead without one; over the budget or for an account that cannot post it is refused, and nothing is created', async () => {
  const off = fakes({ preview: async () => ({ ok: false, reason: 'site.disabled' }) });
  expect(await submit(who, link({ title: 'Typed' }), off.deps)).toEqual({ ok: true, id: 'p1' });
  expect(off.created[0]).not.toHaveProperty('thumbnailUrl');

  const throttled = fakes({ throttle: async () => false });
  expect(await submit(who, link({ title: 'Typed' }), throttled.deps)).toEqual({ ok: false, error: 'rate.limited' });
  expect(throttled.calls).toEqual([]);

  const unverified = fakes({ preview: async () => ({ ok: false, reason: 'auth.email_unverified' }) });
  expect(await submit(who, link({ title: 'Typed' }), unverified.deps)).toEqual({ ok: false, error: 'auth.email_unverified' });
  expect(unverified.calls).toEqual([]);

  const untitled = fakes({ preview: async () => ({ ...page, title: null }) });
  expect(await submit(who, link({ title: '' }), untitled.deps)).toEqual({ ok: false, error: 'title.required' });
  expect(untitled.calls).toEqual([]);
});

test('a text post fetches nothing, and a refusal from createPost comes back by its reason', async () => {
  const { deps, calls } = fakes({ createPost: async () => ({ ok: false, reason: 'community.posting_restricted' }) });
  expect(await submit(who, parsed({ community, title: 'Hello', body: 'Body' }), deps)).toEqual({
    ok: false,
    error: 'community.posting_restricted',
  });
  expect(calls).toEqual([]);
});

test('an image post stores the file first, then links it from this instance with its type and alt text', async () => {
  const { deps, created, calls } = fakes();
  const input = parsed({ community, type: 'image', title: 'Pic', alt: 'A pixel' }, new Uint8Array([1]));
  expect(await submit(who, input, deps)).toEqual({ ok: true, id: 'p1' });
  expect(calls).toEqual(['upload', 'create']);
  expect(created[0]).toMatchObject({ url: 'https://feddit.test/media/u1', urlContentType: 'image/png', altText: 'A pixel' });

  const refused = fakes({ upload: async () => ({ ok: false, reason: 'media.invalid_image' }) });
  expect(await submit(who, input, refused.deps)).toEqual({ ok: false, error: 'media.invalid_image' });
  expect(refused.calls).toEqual([]);
});

test('an edit gets a new preview only when the link moved, and clears the old picture when none is found', async () => {
  const same = fakes({ currentUrl: async () => 'https://example.org/a' });
  await submit(who, { ...link({ title: 'T' }), editing: community }, same.deps);
  expect(same.calls).toEqual(['update']);
  expect(same.edited[0]).not.toHaveProperty('thumbnailUrl');

  const moved = fakes();
  await submit(who, { ...link({ title: 'T' }), editing: community }, moved.deps);
  expect(moved.calls).toEqual(['preview', 'update']);
  expect(moved.edited[0]).toMatchObject({ thumbnailUrl: 'https://img.test/a.png' });

  const none = fakes({ preview: async () => ({ ok: false, reason: 'site.disabled' }) });
  await submit(who, { ...link({ title: 'T' }), editing: community }, none.deps);
  expect(none.edited[0]).toMatchObject({ thumbnailUrl: null, urlContentType: null });
});

test('the answer is a redirect or a code: JSON for the enhanced form, 303 without JavaScript, 429 for the throttle', async () => {
  const json = new Request('https://feddit.test/submit', { method: 'POST', headers: { accept: 'application/json' } });
  const plain = new Request('https://feddit.test/submit', { method: 'POST' });
  const back = { edit: null, kept: { title: 'Typed' } };
  const done = await answer(json, [], { ok: true, id: 'p1' }, back);
  expect([done.status, await done.json()]).toEqual([200, { redirect: '/post/p1' }]);
  const refused = answer(json, [], { ok: false, error: 'community.banned' }, back);
  expect([refused.status, await refused.json()]).toEqual([400, { error: 'community.banned' }]);
  expect(answer(json, [], { ok: false, error: 'rate.limited' }, back).status).toBe(429);

  expect(answer(plain, ['a=1', 'b=2'], { ok: true, id: 'p1' }, back).headers.get('location')).toBe('/post/p1');
  const away = answer(plain, ['a=1', 'b=2'], { ok: false, error: 'community.banned' }, { edit: community, kept: { title: 'Typed' } });
  expect(away.status).toBe(303);
  expect(away.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  const url = new URL(away.headers.get('location')!, 'https://feddit.test');
  expect([url.pathname, url.searchParams.get('error'), url.searchParams.get('edit')]).toEqual(['/submit', 'community.banned', community]);
});
