import { expect, test } from 'vitest';
import type { NewPost, PostEdit } from '@peblish/core/posts/input';
import type { ActingPrincipal } from '@peblish/schema/authz';
import { readFlash } from './-flash.ts';
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
    precheck: async () => (calls.push('precheck'), null),
    throttle: async () => true,
    preview: async () => (calls.push('preview'), page),
    upload: async () => (
      calls.push('upload'),
      { ok: true, id: 'u1', storageKey: 'media/u1.png', mimeType: 'image/png', byteSize: 1, width: 1, height: 1, sha256: '0' }
    ),
    origin: async () => 'https://feddit.test',
    current: async () => ({ url: 'https://old.test/' }),
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
  expect(calls).toEqual(['precheck', 'preview', 'create']);
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
  expect(throttled.calls).toEqual(['precheck']);

  const unverified = fakes({ preview: async () => ({ ok: false, reason: 'auth.email_unverified' }) });
  expect(await submit(who, link({ title: 'Typed' }), unverified.deps)).toEqual({ ok: false, error: 'auth.email_unverified' });
  expect(unverified.calls).toEqual(['precheck']);

  const untitled = fakes({ preview: async () => ({ ...page, title: null }) });
  expect(await submit(who, link({ title: '' }), untitled.deps)).toEqual({ ok: false, error: 'title.required' });
  expect(untitled.calls).toEqual(['precheck']);
});

test('a text post fetches nothing, and a refusal from createPost comes back by its reason', async () => {
  const { deps, calls } = fakes({ createPost: async () => ({ ok: false, reason: 'community.posting_restricted' }) });
  expect(await submit(who, parsed({ community, title: 'Hello', body: 'Body' }), deps)).toEqual({
    ok: false,
    error: 'community.posting_restricted',
  });
  expect(calls).toEqual(['precheck']);
});

test('an image post stores the file first, then links it from this instance with its type and alt text', async () => {
  const { deps, created, calls } = fakes();
  const input = parsed({ community, type: 'image', title: 'Pic', alt: 'A pixel' }, new Uint8Array([1]));
  expect(await submit(who, input, deps)).toEqual({ ok: true, id: 'p1' });
  expect(calls).toEqual(['precheck', 'upload', 'create']);
  expect(created[0]).toMatchObject({ url: 'https://feddit.test/media/u1', urlContentType: 'image/png', altText: 'A pixel' });

  const refused = fakes({ upload: async () => ({ ok: false, reason: 'media.invalid_image' }) });
  expect(await submit(who, input, refused.deps)).toEqual({ ok: false, error: 'media.invalid_image' });
  expect(refused.calls).toEqual(['precheck']);
});

test("who may post is decided first: a refused person costs no preview fetch and no upload, and the reason is the policy's", async () => {
  const deny = (reason: string) => ({
    precheck: async (...asked: Parameters<Deps['precheck']>) => (asks.push(asked), reason),
  });
  const asks: Parameters<Deps['precheck']>[] = [];
  for (const [input, reason] of [
    [link({ title: 'T' }), 'community.banned'],
    [parsed({ community, type: 'image', title: 'Pic' }, new Uint8Array([1])), 'auth.email_unverified'],
    [parsed({ community, title: 'T', body: 'b' }), 'community.deleted'],
  ] as const) {
    const { deps, created, calls } = fakes(deny(reason));
    expect(await submit(who, input, deps)).toEqual({ ok: false, error: reason });
    expect([calls, created]).toEqual([[], []]);
  }
  expect(asks).toEqual(Array(3).fill([principal, { communityId: community }]));

  // An edit asks about the post, before its saved address is read or any preview fetched.
  asks.length = 0;
  const denied = fakes({ ...deny('post.author_required'), current: async () => Promise.reject(new Error('read before the check')) });
  expect(await submit(who, { ...link({ title: 'T' }), editing: community }, denied.deps)).toEqual({
    ok: false,
    error: 'post.author_required',
  });
  expect([asks, denied.calls, denied.edited]).toEqual([[[principal, { postId: community }]], [], []]);
});

test('an edit gets a new preview only when the link moved, and clears the old picture when none is found', async () => {
  const same = fakes({ current: async () => ({ url: 'https://example.org/a' }) });
  await submit(who, { ...link({ title: 'T' }), editing: community }, same.deps);
  expect(same.calls).toEqual(['precheck', 'update']);
  expect(same.edited[0]).not.toHaveProperty('thumbnailUrl');

  const moved = fakes();
  await submit(who, { ...link({ title: 'T' }), editing: community }, moved.deps);
  expect(moved.calls).toEqual(['precheck', 'preview', 'update']);
  expect(moved.edited[0]).toMatchObject({ thumbnailUrl: 'https://img.test/a.png' });

  const none = fakes({ preview: async () => ({ ok: false, reason: 'site.disabled' }) });
  await submit(who, { ...link({ title: 'T' }), editing: community }, none.deps);
  expect(none.edited[0]).toMatchObject({ thumbnailUrl: null, urlContentType: null });
});

test('an edit changes what the saved post has, whatever type the form says', async () => {
  // A text post: a forged link type changes the body and sets no address.
  const text = fakes({ current: async () => ({ url: null }) });
  await submit(who, { ...link({ title: 'T', body: 'new words' }), editing: community }, text.deps);
  expect(text.calls).toEqual(['precheck', 'update']);
  expect(text.edited[0]).toEqual({ title: 'T', sensitive: false, bodyMd: 'new words' });

  // A link post: a forged text type changes the address (with a new preview) and never the body.
  const saved = fakes();
  await submit(
    who,
    { ...parsed({ community, title: 'T', body: 'smuggled', url: 'https://example.org/a' }), editing: community },
    saved.deps,
  );
  expect(saved.edited[0]).not.toHaveProperty('bodyMd');
  expect(saved.edited[0]).toMatchObject({ url: 'https://example.org/a' });

  // The saved type's own checks apply: a link post cannot lose its address, a post that is gone is gone.
  const bare = fakes();
  expect(await submit(who, { ...parsed({ community, title: 'T' }), editing: community }, bare.deps)).toEqual({
    ok: false,
    error: 'url.required',
  });
  const missing = fakes({ current: async () => null });
  expect(await submit(who, { ...parsed({ community, title: 'T' }), editing: community }, missing.deps)).toEqual({
    ok: false,
    error: 'target.not_found',
  });
  expect([bare.calls, missing.calls]).toEqual([['precheck'], ['precheck']]);
});

test('the answer is a redirect or a code: JSON for the enhanced form, 303 without JavaScript, 429 for the throttle', async () => {
  const json = new Request('https://feddit.test/submit', { method: 'POST', headers: { accept: 'application/json' } });
  const plain = new Request('https://feddit.test/submit', { method: 'POST' });
  const back = { viewer: 'ann', edit: null, fields: { title: 'Typed' } };
  const done = await answer(json, [], { ok: true, id: 'p1' }, back);
  expect([done.status, await done.json()]).toEqual([200, { redirect: '/post/p1' }]);
  const refused = answer(json, [], { ok: false, error: 'community.banned' }, back);
  expect([refused.status, await refused.json()]).toEqual([400, { error: 'community.banned' }]);
  expect(answer(json, [], { ok: false, error: 'rate.limited' }, back).status).toBe(429);

  expect(answer(plain, ['a=1', 'b=2'], { ok: true, id: 'p1' }, back).headers.get('location')).toBe('/post/p1');
  const away = answer(plain, ['a=1', 'b=2'], { ok: false, error: 'community.banned' }, { ...back, edit: community });
  expect(away.status).toBe(303);
  expect(away.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  const url = new URL(away.headers.get('location')!, 'https://feddit.test');
  expect([url.pathname, url.searchParams.get('error'), url.searchParams.get('edit')]).toEqual(['/submit', 'community.banned', community]);
});

test('without JavaScript a refusal keeps every typed value for the person who typed it, however long', () => {
  const plain = new Request('https://feddit.test/submit', { method: 'POST' });
  const fields = {
    community,
    type: 'link',
    title: 'Typed',
    url: 'https://example.org/a',
    body: 'a\r\n' + 'b'.repeat(5_000),
    alt: 'Alt',
    nsfw: 'on',
  };
  const location = answer(plain, [], { ok: false, error: 'url.invalid' }, { viewer: 'ann', edit: null, fields }).headers.get('location')!;
  const flash = new URL(location, 'https://feddit.test').searchParams.get('flash');
  expect(location).not.toContain('Typed');
  expect(readFlash(flash ?? undefined, 'ann')).toEqual({
    community,
    type: 'link',
    title: 'Typed',
    url: 'https://example.org/a',
    body: 'a\n' + 'b'.repeat(5_000),
    alt: 'Alt',
    nsfw: true,
  });
  expect(readFlash(flash ?? undefined, 'bob')).toBeNull();

  // Nothing to keep for: the form could not be read, or is no form's.
  for (const nothing of [
    { viewer: 'ann', edit: null, fields: null },
    { viewer: 'ann', edit: null, fields: { type: 'poll' } },
  ]) {
    const away = answer(plain, [], { ok: false, error: 'generic' }, nothing).headers.get('location')!;
    expect(new URL(away, 'https://feddit.test').searchParams.has('flash')).toBe(false);
  }
});

test('signed out, the way back is the sign-in page and then a clean form, with no refusal in it', () => {
  const plain = new Request('https://feddit.test/submit', { method: 'POST' });
  const out = (edit: string | null) =>
    answer(plain, [], { ok: false, error: 'auth.required' }, { viewer: null, edit, fields: { title: 'Typed' } }).headers.get('location')!;
  expect(new URL(out(null), 'https://feddit.test').searchParams.get('redirect')).toBe('/submit');
  const aimed = new URL(out(community), 'https://feddit.test');
  expect([aimed.pathname, aimed.searchParams.get('redirect')]).toEqual(['/auth/sign-in', `/submit?edit=${community}`]);
  expect(`${out(null)}${out(community)}`).not.toMatch(/error|auth\.required|Typed|flash/);
});
